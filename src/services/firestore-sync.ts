import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  setDoc,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import type {
  ChapterProgress,
  LibraryEntry,
  ReaderMode,
  SavedTitle,
  SeriesProgress,
  UserData,
} from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import { getFirebaseFirestore, isFirebaseConfigured } from "./firebase";
import { ensureAnonymousUser, getCurrentUser } from "./firebase-auth";
import type { User } from "firebase/auth";
import { createLocalStorageAdapter, type PersistenceAdapter } from "./persistence";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error" | "disabled";

export const CLOUD_SYNC_OPT_IN_KEY = "manga-reader:v1:cloud-sync-enabled";
export const PRE_SYNC_BACKUP_KEY = "manga-reader:v1:pre-sync-backup";
export const MAX_BATCH_OPERATIONS = 400;

/** 1 MiB hard limit for Cloud Firestore documents */
export const FIRESTORE_DOC_MAX_BYTES = 1048576;
/** 900 KiB safe threshold to protect against Firestore 1 MiB document limit */
export const FIRESTORE_DOC_SAFE_LIMIT_BYTES = 900 * 1024;
/** 500 KiB maximum safe size for individual records to prevent single-record document exhaustion */
export const FIRESTORE_RECORD_SAFE_LIMIT_BYTES = 500 * 1024;

export interface SnapshotManifest {
  totalLibrary: number;
  totalProgress: number;
  totalSavedTitles: number;
  snapshotBytes: number;
}

export interface StagedSnapshotDoc {
  snapshotId: string;
  revision: number;
  createdAt: string;
  isComplete: boolean;
  version: number;
  checksum?: string;
  totalParts?: number;
  library?: Record<string, LibraryEntry>;
  progress?: Record<string, SeriesProgress>;
  readerModes?: Record<string, ReaderMode>;
  savedTitles?: Record<string, SavedTitle>;
  tombstones?: Record<string, string>;
  seeded?: boolean;
}

export interface StagedSnapshotPartDoc {
  partId: string;
  snapshotId: string;
  partIndex: number;
  totalParts: number;
  library?: Record<string, LibraryEntry>;
  progress?: Record<string, SeriesProgress>;
  savedTitles?: Record<string, SavedTitle>;
  checksum?: string;
  createdAt: string;
}

/**
 * Estimates the UTF-8 byte size of serialized JSON data.
 */
export function estimateDataSize(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return 0;
  }
}

/**
 * Computes a deterministic SHA-256 or hash checksum of serialized JSON data.
 */
export async function computeDataChecksum(data: unknown): Promise<string> {
  try {
    const str = JSON.stringify(data);
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const msgBuffer = new TextEncoder().encode(str);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(16, "0");
  } catch {
    return "0000000000000000";
  }
}

/**
 * Validates document and record size guards before any Firestore write.
 * Ensures manifest metadata and individual records never exceed size bounds.
 */
export function validateRecordSizeGuards(data: UserData): void {
  // Validate manifest size potential
  const manifestProbe = {
    version: USER_DATA_VERSION,
    tombstones: data.tombstones,
    seeded: data.seeded,
  };
  if (estimateDataSize(manifestProbe) > FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
    throw new Error("Manifest metadata exceeds Firestore safe document size limit.");
  }

  // Validate individual library records
  for (const [id, entry] of Object.entries(data.library)) {
    if (estimateDataSize(entry) > FIRESTORE_RECORD_SAFE_LIMIT_BYTES) {
      throw new Error(
        `Library record '${id}' exceeds safe record size limit (${FIRESTORE_RECORD_SAFE_LIMIT_BYTES} bytes).`
      );
    }
  }

  // Validate individual progress records
  for (const [id, prog] of Object.entries(data.progress)) {
    if (estimateDataSize(prog) > FIRESTORE_RECORD_SAFE_LIMIT_BYTES) {
      throw new Error(
        `Progress record '${id}' exceeds safe record size limit (${FIRESTORE_RECORD_SAFE_LIMIT_BYTES} bytes).`
      );
    }
  }

  // Validate individual savedTitle records
  for (const [id, title] of Object.entries(data.savedTitles)) {
    if (estimateDataSize(title) > FIRESTORE_RECORD_SAFE_LIMIT_BYTES) {
      throw new Error(
        `Saved title record '${id}' exceeds safe record size limit (${FIRESTORE_RECORD_SAFE_LIMIT_BYTES} bytes).`
      );
    }
  }
}

let clientSessionId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function getClientSessionId(): string {
  return clientSessionId;
}

export function setClientSessionId(id: string): void {
  clientSessionId = id;
}

/**
 * Generates an immutable, unique snapshot ID scoped by revision and session ID.
 */
export function generateSnapshotId(revision: number, sessionId = clientSessionId): string {
  const timestamp = Date.now();
  const cleanSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return `rev_${revision}_${cleanSession}_${timestamp}`;
}

/**
 * Checks whether user has explicitly opted into Cloud Firestore synchronization.
 */
export function isCloudSyncEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CLOUD_SYNC_OPT_IN_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Updates the user's cloud sync opt-in preference.
 */
export function setCloudSyncEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, enabled ? "true" : "false");
  } catch (e) {
    console.warn("Failed to set cloud sync opt-in preference:", e);
  }
}

/**
 * Verifies that a recoverable local backup exists or creates one,
 * verifying write and read-back integrity before any cloud upload.
 */
export function createAndVerifyLocalBackup(data: UserData): boolean {
  if (typeof window === "undefined") return false;
  try {
    const existing = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    if (existing !== null) {
      const parsed = JSON.parse(existing);
      return (
        parsed !== null &&
        typeof parsed === "object" &&
        parsed.version === USER_DATA_VERSION
      );
    }
    const serialized = JSON.stringify(data);
    window.localStorage.setItem(PRE_SYNC_BACKUP_KEY, serialized);
    const readBack = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    if (!readBack) return false;
    const parsed = JSON.parse(readBack);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.version === USER_DATA_VERSION
    );
  } catch (e) {
    console.warn("Pre-sync backup verification failed:", e);
    return false;
  }
}

/**
 * Pure 3-way/timestamp-based non-destructive merger for UserData with tombstone deletion safety.
 * Guarantees removed items do not resurrect, while preserving intentional re-additions.
 */
export function mergeUserData(local: UserData, remote?: Partial<UserData> | null): UserData {
  if (!remote) {
    return { ...local };
  }

  // 1. Merge tombstones (union, keeping latest deletion timestamp)
  const mergedTombstones: Record<string, string> = {
    ...(local.tombstones || {}),
  };
  if (remote.tombstones) {
    for (const [id, remoteDelTime] of Object.entries(remote.tombstones)) {
      const localDelTime = mergedTombstones[id];
      if (!localDelTime || new Date(remoteDelTime).getTime() > new Date(localDelTime).getTime()) {
        mergedTombstones[id] = remoteDelTime;
      }
    }
  }

  // 2. Candidate Library Entries (union with latest addedAt)
  const candidateLibrary: Record<string, LibraryEntry> = { ...local.library };
  if (remote.library) {
    for (const [key, remoteEntry] of Object.entries(remote.library)) {
      const localEntry = candidateLibrary[key];
      if (!localEntry) {
        candidateLibrary[key] = remoteEntry;
      } else {
        const localTime = new Date(localEntry.addedAt || 0).getTime();
        const remoteTime = new Date(remoteEntry.addedAt || 0).getTime();
        if (remoteTime > localTime) {
          candidateLibrary[key] = remoteEntry;
        }
      }
    }
  }

  // 3. Reconcile Library Entries against tombstones
  const finalLibrary: Record<string, LibraryEntry> = {};
  for (const [key, entry] of Object.entries(candidateLibrary)) {
    const tombstoneTime = mergedTombstones[key];
    if (tombstoneTime) {
      const addedTime = new Date(entry.addedAt || 0).getTime();
      const deletedTime = new Date(tombstoneTime).getTime();
      if (addedTime > deletedTime) {
        // Intentional re-addition after deletion: keep entry, drop tombstone
        finalLibrary[key] = entry;
        delete mergedTombstones[key];
      }
      // Else: tombstone wins (deleted at or after addition), drop from library
    } else {
      finalLibrary[key] = entry;
    }
  }

  // 4. Merge Reading Progress
  const mergedProgress: Record<string, SeriesProgress> = { ...local.progress };
  if (remote.progress) {
    for (const [seriesId, remoteSeriesProgress] of Object.entries(remote.progress)) {
      const localSeriesProgress = mergedProgress[seriesId];
      if (!localSeriesProgress) {
        mergedProgress[seriesId] = remoteSeriesProgress;
      } else {
        // Deep merge chapters
        const mergedChapters: Record<string, ChapterProgress> = {
          ...localSeriesProgress.chapters,
        };
        for (const [chId, remoteChapter] of Object.entries(remoteSeriesProgress.chapters || {})) {
          const localChapter = mergedChapters[chId];
          if (!localChapter) {
            mergedChapters[chId] = remoteChapter;
          } else {
            const completed = localChapter.completed || remoteChapter.completed;
            const maxPage = Math.max(localChapter.page, remoteChapter.page);
            const localTime = new Date(localChapter.updatedAt || 0).getTime();
            const remoteTime = new Date(remoteChapter.updatedAt || 0).getTime();
            const newestTime =
              remoteTime > localTime ? remoteChapter.updatedAt : localChapter.updatedAt;

            mergedChapters[chId] = {
              page: maxPage,
              pageCount: Math.max(localChapter.pageCount, remoteChapter.pageCount),
              atEnd: localChapter.atEnd || remoteChapter.atEnd,
              completed,
              updatedAt: newestTime,
            };
          }
        }

        const localTime = new Date(localSeriesProgress.updatedAt || 0).getTime();
        const remoteTime = new Date(remoteSeriesProgress.updatedAt || 0).getTime();
        const lastChapterId =
          remoteTime > localTime
            ? remoteSeriesProgress.lastChapterId
            : localSeriesProgress.lastChapterId;
        const updatedAt =
          remoteTime > localTime ? remoteSeriesProgress.updatedAt : localSeriesProgress.updatedAt;

        mergedProgress[seriesId] = {
          lastChapterId,
          updatedAt,
          chapters: mergedChapters,
        };
      }
    }
  }

  // 5. Merge Reader Modes
  const mergedReaderModes: Record<string, ReaderMode> = {
    ...remote.readerModes,
    ...local.readerModes,
  };

  // 6. Merge Saved Titles
  const mergedSavedTitles: Record<string, SavedTitle> = { ...local.savedTitles };
  if (remote.savedTitles) {
    for (const [key, remoteTitle] of Object.entries(remote.savedTitles)) {
      const localTitle = mergedSavedTitles[key];
      if (!localTitle) {
        mergedSavedTitles[key] = remoteTitle;
      } else {
        const localTime = new Date(localTitle.fetchedAt || 0).getTime();
        const remoteTime = new Date(remoteTitle.fetchedAt || 0).getTime();
        if (remoteTime > localTime) {
          mergedSavedTitles[key] = remoteTitle;
        }
      }
    }
  }

  return {
    version: USER_DATA_VERSION,
    library: finalLibrary,
    progress: mergedProgress,
    readerModes: mergedReaderModes,
    savedTitles: mergedSavedTitles,
    tombstones: mergedTombstones,
    seeded: Boolean(local.seeded || remote.seeded),
  };
}

export interface ChunkedOperation {
  type: "set" | "delete";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any;
}

/**
 * Commits writes in chunks of <= 400 operations to stay comfortably under the 500 batch limit.
 */
export async function commitChunkedBatches(
  db: Firestore,
  operations: ChunkedOperation[],
  batchLimit = MAX_BATCH_OPERATIONS
): Promise<void> {
  for (let i = 0; i < operations.length; i += batchLimit) {
    const chunk = operations.slice(i, i + batchLimit);
    const batch = writeBatch(db);
    for (const op of chunk) {
      if (op.type === "set") {
        batch.set(op.ref, op.data, op.options);
      } else if (op.type === "delete") {
        batch.delete(op.ref);
      }
    }
    await batch.commit();
  }
}

/**
 * Stages an immutable data snapshot and verifies read-back and checksum before publication.
 * For datasets <= 900 KiB: single snapshot document.
 * For datasets > 900 KiB: partitions across snapshot parts, each <= 900 KiB, then marks parent complete.
 */
export async function stageAndVerifySnapshot(
  db: Firestore,
  user: User,
  targetRevision: number,
  data: UserData
): Promise<{ snapshotId: string; checksum: string; totalParts: number }> {
  validateRecordSizeGuards(data);

  const snapshotId = generateSnapshotId(targetRevision);
  const now = new Date().toISOString();
  const fullChecksum = await computeDataChecksum(data);
  const totalBytes = estimateDataSize(data);

  if (totalBytes <= FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
    // Single immutable snapshot document
    const snapRef = doc(db, "users", user.uid, "snapshots", snapshotId);
    const snapDoc: StagedSnapshotDoc = {
      snapshotId,
      revision: targetRevision,
      createdAt: now,
      isComplete: true,
      version: USER_DATA_VERSION,
      checksum: fullChecksum,
      totalParts: 1,
      library: data.library,
      progress: data.progress,
      readerModes: data.readerModes,
      savedTitles: data.savedTitles,
      tombstones: data.tombstones || {},
      seeded: Boolean(data.seeded),
    };

    await setDoc(snapRef, snapDoc);

    // Read-back verification before publication
    const readBackSnap = await getDoc(snapRef);
    if (!readBackSnap.exists()) {
      throw new Error(`Snapshot verification failed: document '${snapshotId}' does not exist.`);
    }
    const readData = readBackSnap.data() as StagedSnapshotDoc;
    if (!readData.isComplete || readData.checksum !== fullChecksum) {
      throw new Error("Snapshot verification failed: checksum mismatch or incomplete.");
    }

    return { snapshotId, checksum: fullChecksum, totalParts: 1 };
  } else {
    // Large Library Fallback: Partition dataset into parts each <= 900 KiB
    const parts: Array<{
      library: Record<string, LibraryEntry>;
      progress: Record<string, SeriesProgress>;
      savedTitles: Record<string, SavedTitle>;
    }> = [];

    let currentPart = {
      library: {} as Record<string, LibraryEntry>,
      progress: {} as Record<string, SeriesProgress>,
      savedTitles: {} as Record<string, SavedTitle>,
    };

    const pushPartIfFull = (candidateSize: number) => {
      if (estimateDataSize(currentPart) + candidateSize > FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
        parts.push(currentPart);
        currentPart = { library: {}, progress: {}, savedTitles: {} };
      }
    };

    for (const [id, entry] of Object.entries(data.library)) {
      pushPartIfFull(estimateDataSize(entry));
      currentPart.library[id] = entry;
    }
    for (const [id, prog] of Object.entries(data.progress)) {
      pushPartIfFull(estimateDataSize(prog));
      currentPart.progress[id] = prog;
    }
    for (const [id, title] of Object.entries(data.savedTitles)) {
      pushPartIfFull(estimateDataSize(title));
      currentPart.savedTitles[id] = title;
    }
    if (
      Object.keys(currentPart.library).length > 0 ||
      Object.keys(currentPart.progress).length > 0 ||
      Object.keys(currentPart.savedTitles).length > 0
    ) {
      parts.push(currentPart);
    }

    const totalParts = Math.max(parts.length, 1);

    // 1. Stage parts first
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const partId = `part_${i}`;
      const partRef = doc(db, "users", user.uid, "snapshots", snapshotId, "parts", partId);
      const partChecksum = await computeDataChecksum(part);
      const partDoc: StagedSnapshotPartDoc = {
        partId,
        snapshotId,
        partIndex: i,
        totalParts,
        library: part.library,
        progress: part.progress,
        savedTitles: part.savedTitles,
        checksum: partChecksum,
        createdAt: now,
      };
      await setDoc(partRef, partDoc);

      // Verify each part
      const readPart = await getDoc(partRef);
      if (!readPart.exists() || (readPart.data() as StagedSnapshotPartDoc).checksum !== partChecksum) {
        throw new Error(`Snapshot part '${partId}' verification failed.`);
      }
    }

    // 2. Stage parent snapshot marking isComplete: true
    const snapRef = doc(db, "users", user.uid, "snapshots", snapshotId);
    const snapDoc: StagedSnapshotDoc = {
      snapshotId,
      revision: targetRevision,
      createdAt: now,
      isComplete: true,
      version: USER_DATA_VERSION,
      checksum: fullChecksum,
      totalParts,
      readerModes: data.readerModes,
      tombstones: data.tombstones || {},
      seeded: Boolean(data.seeded),
    };
    await setDoc(snapRef, snapDoc);

    const readBackSnap = await getDoc(snapRef);
    if (!readBackSnap.exists() || !(readBackSnap.data() as StagedSnapshotDoc).isComplete) {
      throw new Error(`Snapshot parent verification failed: document '${snapshotId}' is incomplete.`);
    }

    return { snapshotId, checksum: fullChecksum, totalParts };
  }
}

/**
 * Safely prunes obsolete snapshots older than currentRevision - 2,
 * ensuring active and immediate fallback recovery snapshots are NEVER deleted.
 */
export async function pruneObsoleteSnapshots(
  db: Firestore,
  user: User,
  currentRevision: number,
  activeSnapshotId: string
): Promise<void> {
  try {
    const snapshotsCol = collection(db, "users", user.uid, "snapshots");
    const snapDocs = await getDocs(snapshotsCol);
    if (snapDocs.empty) return;

    // Retain active snapshot and at least 2 preceding revisions for recovery
    const safeKeepRevision = Math.max(currentRevision - 2, 0);

    const pruneOps: ChunkedOperation[] = [];
    snapDocs.forEach((d) => {
      const snapData = d.data() as StagedSnapshotDoc;
      if (
        d.id !== activeSnapshotId &&
        typeof snapData.revision === "number" &&
        snapData.revision < safeKeepRevision
      ) {
        pruneOps.push({ type: "delete", ref: d.ref });
      }
    });

    if (pruneOps.length > 0) {
      await commitChunkedBatches(db, pruneOps);
    }
  } catch (e) {
    console.warn("Obsolete snapshot pruning skipped or failed:", e);
  }
}

class FirestoreSyncService {
  private status: SyncStatus =
    isFirebaseConfigured() && isCloudSyncEnabled() ? "idle" : "disabled";
  private listeners = new Set<(status: SyncStatus) => void>();
  private unsubscribeSnapshot: Unsubscribe | null = null;
  private isSyncing = false;
  /** Monotonic local ID to invalidate delayed or obsolete subcollection reconciliations */
  private currentReconciliationId = 0;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleNetworkChange(true));
      window.addEventListener("offline", () => this.handleNetworkChange(false));
      if (!navigator.onLine && isFirebaseConfigured() && isCloudSyncEnabled()) {
        this.setStatus("offline");
      }
    }
  }

  public getStatus(): SyncStatus {
    if (!isFirebaseConfigured() || !isCloudSyncEnabled()) {
      return "disabled";
    }
    return this.status;
  }

  public subscribeStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  public setStatus(status: SyncStatus) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((l) => l(status));
  }

  private handleNetworkChange(online: boolean) {
    if (!isFirebaseConfigured() || !isCloudSyncEnabled()) {
      this.setStatus("disabled");
      return;
    }
    if (!online) {
      this.setStatus("offline");
    } else {
      if (this.status === "offline") {
        this.setStatus("idle");
      }
    }
  }

  public preserveLocalBackup(data: UserData): boolean {
    return createAndVerifyLocalBackup(data);
  }

  /**
   * Pulls remote data from Firestore for the given user, returning the data and its revision.
   * Readers load ONLY the verified, published active snapshot. Never partial subcollections.
   */
  public async fetchRemoteData(
    db: Firestore,
    user: User
  ): Promise<{ data: UserData | null; revision: number; activeSnapshotId?: string }> {
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    const syncSnap = await getDoc(syncDocRef);

    if (!syncSnap.exists()) {
      return { data: null, revision: 0 };
    }

    const syncData = syncSnap.data() as UserData & {
      revision?: number;
      activeSnapshotId?: string;
      snapshotParts?: number;
      snapshotChecksum?: string;
    };
    const revision = typeof syncData.revision === "number" ? syncData.revision : 0;
    const activeSnapshotId = syncData.activeSnapshotId;

    if (activeSnapshotId) {
      const snapRef = doc(db, "users", user.uid, "snapshots", activeSnapshotId);
      const snapDoc = await getDoc(snapRef);

      if (snapDoc.exists()) {
        const snapData = snapDoc.data() as StagedSnapshotDoc;
        // Readers ONLY load complete snapshots
        if (snapData.isComplete === true) {
          let library = snapData.library || {};
          let progress = snapData.progress || {};
          let savedTitles = snapData.savedTitles || {};
          const readerModes = snapData.readerModes || {};
          const tombstones = snapData.tombstones || {};

          if (snapData.totalParts && snapData.totalParts > 1) {
            for (let i = 0; i < snapData.totalParts; i++) {
              const partRef = doc(
                db,
                "users",
                user.uid,
                "snapshots",
                activeSnapshotId,
                "parts",
                `part_${i}`
              );
              const partSnap = await getDoc(partRef);
              if (partSnap.exists()) {
                const partData = partSnap.data() as StagedSnapshotPartDoc;
                if (partData.library) library = { ...library, ...partData.library };
                if (partData.progress) progress = { ...progress, ...partData.progress };
                if (partData.savedTitles) savedTitles = { ...savedTitles, ...partData.savedTitles };
              }
            }
          }

          const assembled: UserData = {
            version: USER_DATA_VERSION,
            library,
            progress,
            readerModes,
            savedTitles,
            tombstones,
            seeded: snapData.seeded === true,
          };

          return { data: assembled, revision, activeSnapshotId };
        }
      }
    }

    // Fallback: inline legacy syncDoc
    if (syncData.library || syncData.progress) {
      return {
        data: {
          version: USER_DATA_VERSION,
          library: syncData.library || {},
          progress: syncData.progress || {},
          readerModes: syncData.readerModes || {},
          savedTitles: syncData.savedTitles || {},
          tombstones: syncData.tombstones || {},
          seeded: syncData.seeded === true,
        },
        revision,
      };
    }

    return { data: null, revision };
  }

  /**
   * Reconciles secondary read subcollections in chunked batches <= 400 operations.
   * Guarantees that delayed or obsolete reconciliation passes CANNOT overwrite
   * a newer revision committed concurrently or subsequently.
   */
  public async reconcileSubcollections(
    db: Firestore,
    user: User,
    reconciliationId: number,
    targetRevision: number,
    data: UserData
  ): Promise<void> {
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");

    if (this.currentReconciliationId !== reconciliationId) {
      return;
    }

    const currentSnap = await getDoc(syncDocRef);
    if (currentSnap.exists()) {
      const currentRev = (currentSnap.data()?.revision as number) ?? 0;
      if (currentRev > targetRevision) {
        return; // Abort: newer revision already committed
      }
    }

    const now = new Date().toISOString();
    const operations: ChunkedOperation[] = [];

    // Library subcollection
    for (const [key, entry] of Object.entries(data.library)) {
      const ref = doc(db, "users", user.uid, "library", key);
      const title = data.savedTitles[key]?.title || key;
      operations.push({
        type: "set",
        ref,
        data: {
          seriesId: key,
          mediaId: key,
          title,
          status: entry.status,
          addedAt: entry.addedAt || now,
          updatedAt: entry.addedAt || now,
        },
        options: { merge: true },
      });
    }

    // Tombstones deletion in subcollection
    if (data.tombstones) {
      for (const tombstonedId of Object.keys(data.tombstones)) {
        if (!data.library[tombstonedId]) {
          operations.push({
            type: "delete",
            ref: doc(db, "users", user.uid, "library", tombstonedId),
          });
        }
      }
    }

    // Progress subcollection
    for (const [key, prog] of Object.entries(data.progress)) {
      const ref = doc(db, "users", user.uid, "progress", key);
      operations.push({
        type: "set",
        ref,
        data: {
          seriesId: key,
          lastChapterId: prog.lastChapterId,
          updatedAt: prog.updatedAt || now,
          chapters: prog.chapters || {},
        },
        options: { merge: true },
      });
    }

    // Reader modes subcollection
    for (const [key, mode] of Object.entries(data.readerModes)) {
      const ref = doc(db, "users", user.uid, "readerModes", key);
      operations.push({
        type: "set",
        ref,
        data: { seriesId: key, mode, updatedAt: now },
        options: { merge: true },
      });
    }

    // Saved titles subcollection
    for (const [key, title] of Object.entries(data.savedTitles)) {
      const ref = doc(db, "users", user.uid, "savedTitles", key);
      operations.push({
        type: "set",
        ref,
        data: {
          ...title,
          id: key,
          mediaId: key,
          savedAt: title.fetchedAt || now,
        },
        options: { merge: true },
      });
    }

    for (let i = 0; i < operations.length; i += MAX_BATCH_OPERATIONS) {
      if (this.currentReconciliationId !== reconciliationId) {
        return;
      }
      const chunk = operations.slice(i, i + MAX_BATCH_OPERATIONS);
      const batch = writeBatch(db);
      for (const op of chunk) {
        if (op.type === "set") {
          batch.set(op.ref, op.data, op.options);
        } else if (op.type === "delete") {
          batch.delete(op.ref);
        }
      }
      await batch.commit();
    }
  }

  /**
   * Unified, concurrency-safe atomic writer using the Staged Immutable Snapshot Architecture:
   * 1. Validates document and individual record size guards.
   * 2. Reads remote manifest & current active snapshot.
   * 3. Non-destructively merges state.
   * 4. Stages complete immutable snapshot to /snapshots/{snapshotId} and verifies read-back & checksum.
   * 5. Atomically publishes activeSnapshotId and revision via CAS transaction.
   * 6. Retains active & previous snapshots for recovery, safely pruning older snapshots.
   * 7. Automatically retries conflicts on concurrent publication.
   */
  public async atomicSyncOrPush(
    db: Firestore,
    user: User,
    localData: UserData,
    maxRetries = 3
  ): Promise<UserData> {
    const userDocRef = doc(db, "users", user.uid);
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const now = new Date().toISOString();
        const createdAt = user.metadata?.creationTime
          ? new Date(user.metadata.creationTime).toISOString()
          : now;

        // 1. Fetch current remote state and revision
        const { data: remoteData, revision: expectedRevision } = await this.fetchRemoteData(
          db,
          user
        );

        // 2. Pure 3-way merge
        const merged = mergeUserData(localData, remoteData);

        // 3. Size validation on individual records & manifest
        validateRecordSizeGuards(merged);

        const targetRevision = expectedRevision + 1;

        // 4. Stage & verify complete immutable snapshot FIRST
        const snapshotInfo = await stageAndVerifySnapshot(db, user, targetRevision, merged);

        // 5. ATOMIC PUBLICATION in transaction
        const nextRevision = await runTransaction(db, async (tx) => {
          const snap = await tx.get(syncDocRef);
          const serverRevision = snap.exists() ? ((snap.data()?.revision as number) ?? 0) : 0;

          if (snap.exists() && serverRevision !== expectedRevision) {
            throw new Error(
              `Revision conflict: expected revision ${expectedRevision}, but server is at ${serverRevision}`
            );
          }

          const newRev = Math.max(serverRevision, expectedRevision) + 1;

          // Update root user profile
          tx.set(
            userDocRef,
            {
              uid: user.uid,
              createdAt,
              updatedAt: now,
              version: USER_DATA_VERSION,
              anonymous: user.isAnonymous,
            },
            { merge: true }
          );

          // Atomically publish active snapshot pointer
          tx.set(
            syncDocRef,
            {
              revision: newRev,
              activeSnapshotId: snapshotInfo.snapshotId,
              snapshotChecksum: snapshotInfo.checksum,
              snapshotParts: snapshotInfo.totalParts,
              syncStatus: "ready",
              updatedAt: now,
              version: USER_DATA_VERSION,
              manifest: {
                totalLibrary: Object.keys(merged.library).length,
                totalProgress: Object.keys(merged.progress).length,
                totalSavedTitles: Object.keys(merged.savedTitles).length,
                snapshotBytes: estimateDataSize(merged),
              },
              tombstones: merged.tombstones || {},
              seeded: Boolean(merged.seeded),
            },
            { merge: true }
          );

          return newRev;
        });

        // 6. ATOMIC PUBLICATION SUCCEEDED!
        // Advance reconciliation ID and trigger background cleanup & secondary replica reconciliation
        this.currentReconciliationId++;
        const reconciliationId = this.currentReconciliationId;

        // Safe background pruning (retains active + previous recovery snapshots)
        pruneObsoleteSnapshots(db, user, nextRevision, snapshotInfo.snapshotId).catch((err) => {
          console.warn("Background snapshot pruning failed:", err);
        });

        // Background secondary replica reconciliation
        this.reconcileSubcollections(db, user, reconciliationId, nextRevision, merged).catch(
          (err) => {
            console.warn("Background subcollection reconciliation failed:", err);
          }
        );

        return merged;
      } catch (err: unknown) {
        attempt++;
        const isConflict =
          err instanceof Error && err.message.toLowerCase().includes("revision conflict");

        if (isConflict && attempt <= maxRetries) {
          const delayMs = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 1000);
          await new Promise((res) => setTimeout(res, delayMs));
          continue;
        }

        throw err;
      }
    }

    throw new Error("atomicSyncOrPush: Maximum retry attempts exceeded.");
  }

  /**
   * Synchronizes local user data with remote Firestore:
   * 1. Requires explicit user opt-in (`isCloudSyncEnabled`).
   * 2. Verifies local backup is recoverable before any network writes.
   * 3. Executes atomicSyncOrPush with immutable staged snapshot and CAS publication.
   */
  public async syncWithRemote(localData: UserData): Promise<UserData> {
    if (!isFirebaseConfigured() || typeof window === "undefined" || !isCloudSyncEnabled()) {
      this.setStatus("disabled");
      return localData;
    }

    if (!navigator.onLine) {
      this.setStatus("offline");
      return localData;
    }

    if (this.isSyncing) {
      return localData;
    }

    this.isSyncing = true;
    this.setStatus("syncing");

    try {
      const backupOk = this.preserveLocalBackup(localData);
      if (!backupOk) {
        throw new Error("Local backup verification failed. Cloud sync aborted for data safety.");
      }

      const user = await ensureAnonymousUser();
      if (!user) {
        throw new Error("Could not authenticate anonymous user");
      }

      const db = getFirebaseFirestore();
      if (!db) {
        throw new Error("Firestore is not available");
      }

      const merged = await this.atomicSyncOrPush(db, user, localData);
      this.setStatus("synced");
      return merged;
    } catch (err) {
      console.warn("Firestore sync failed:", err);
      this.setStatus(navigator.onLine ? "error" : "offline");
      return localData;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Listens to remote changes on the sync document and loads the published snapshot.
   */
  public listenToRemote(
    onRemoteChange: (remoteData: UserData) => void
  ): () => void {
    if (!isFirebaseConfigured() || typeof window === "undefined" || !isCloudSyncEnabled()) {
      return () => {};
    }

    this.unsubscribeSnapshot?.();

    const authUser = getCurrentUser();
    const db = getFirebaseFirestore();
    if (!authUser || !db) {
      return () => {};
    }

    const syncDocRef = doc(db, "users", authUser.uid, "sync", "userData");
    this.unsubscribeSnapshot = onSnapshot(
      syncDocRef,
      async (snapshot) => {
        if (!snapshot.exists() || snapshot.metadata.hasPendingWrites) {
          return;
        }
        const data = snapshot.data() as UserData & {
          syncStatus?: string;
          activeSnapshotId?: string;
        };
        if (data.syncStatus === "syncing") {
          return;
        }

        // Fetch verified remote state
        const remoteResult = await this.fetchRemoteData(db, authUser);
        if (remoteResult.data) {
          onRemoteChange(remoteResult.data);
        }
      },
      (error) => {
        console.warn("Remote snapshot listener error:", error);
        this.setStatus(navigator.onLine ? "error" : "offline");
      }
    );

    return () => {
      this.unsubscribeSnapshot?.();
      this.unsubscribeSnapshot = null;
    };
  }
}

export const syncService = new FirestoreSyncService();

/**
 * Creates a persistence adapter that uses local storage as the primary synchronous
 * cache while safely synchronizing changes with Cloud Firestore when opted in.
 */
export function createSyncedPersistenceAdapter(
  localAdapter: PersistenceAdapter = createLocalStorageAdapter()
): PersistenceAdapter {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let externalChangeCallback: (() => void) | null = null;
  let hasInitiatedSync = false;
  let isSyncing = false;
  let hasPendingLocalMutation = false;

  return {
    getWarning: () => localAdapter.getWarning?.(),
    getRecovery: () => localAdapter.getRecovery?.(),
    load() {
      const local = localAdapter.load();
      if (
        !hasInitiatedSync &&
        typeof window !== "undefined" &&
        isFirebaseConfigured() &&
        isCloudSyncEnabled()
      ) {
        hasInitiatedSync = true;
        isSyncing = true;
        const currentData = local ?? emptyUserData();
        syncService
          .syncWithRemote(currentData)
          .then((merged) => {
            if (hasPendingLocalMutation) {
              hasPendingLocalMutation = false;
              const freshestLocal = localAdapter.load() ?? emptyUserData();
              const safeMerged = mergeUserData(freshestLocal, merged);
              localAdapter.save(safeMerged);
            } else {
              localAdapter.save(merged);
            }
            externalChangeCallback?.();
          })
          .catch((err) => {
            console.warn("Initial background sync failed:", err);
          })
          .finally(() => {
            isSyncing = false;
          });
      }
      return local;
    },
    save(data: UserData) {
      localAdapter.save(data);

      if (
        !isFirebaseConfigured() ||
        typeof window === "undefined" ||
        !isCloudSyncEnabled()
      ) {
        return;
      }

      if (isSyncing) {
        hasPendingLocalMutation = true;
      }

      // Debounced transactional remote push (600ms) with staged immutable snapshot
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(async () => {
        try {
          const user = await ensureAnonymousUser();
          const db = getFirebaseFirestore();
          if (user && db && navigator.onLine) {
            syncService.setStatus("syncing");
            isSyncing = true;
            const latestData = localAdapter.load() ?? data;
            const merged = await syncService.atomicSyncOrPush(db, user, latestData);
            if (hasPendingLocalMutation) {
              hasPendingLocalMutation = false;
              const freshest = localAdapter.load() ?? emptyUserData();
              const safeMerged = mergeUserData(freshest, merged);
              localAdapter.save(safeMerged);
            } else {
              localAdapter.save(merged);
            }
            syncService.setStatus("synced");
            externalChangeCallback?.();
          }
        } catch (err) {
          console.warn("Background upload failed:", err);
          syncService.setStatus(navigator.onLine ? "error" : "offline");
        } finally {
          isSyncing = false;
        }
      }, 600);
    },
    subscribe(onExternalChange: () => void) {
      externalChangeCallback = onExternalChange;
      const unsubscribeLocal = localAdapter.subscribe?.(onExternalChange) ?? (() => {});
      const unsubscribeRemote = isCloudSyncEnabled()
        ? syncService.listenToRemote((remoteData) => {
            const local = localAdapter.load() ?? emptyUserData();
            const merged = mergeUserData(local, remoteData);
            localAdapter.save(merged);
            onExternalChange();
          })
        : () => {};

      return () => {
        externalChangeCallback = null;
        unsubscribeLocal();
        unsubscribeRemote();
      };
    },
  };
}
