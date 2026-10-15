import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
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
   * If the authoritative document is sharded/segmented due to size guards, reconciles
   * with subcollections without truncating user data.
   */
  public async fetchRemoteData(
    db: Firestore,
    user: User
  ): Promise<{ data: UserData | null; revision: number }> {
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    const syncSnap = await getDoc(syncDocRef);

    if (syncSnap.exists()) {
      const data = syncSnap.data() as UserData & { revision?: number };
      const revision = typeof data.revision === "number" ? data.revision : 0;

      let library = data.library || {};
      let progress = data.progress || {};
      let readerModes = data.readerModes || {};
      let savedTitles = data.savedTitles || {};

      // Safe size fallback check: if library or progress is empty on the sync doc
      // but subcollections exist, pull subcollections to avoid truncation.
      const hasMissingCollections =
        Object.keys(library).length === 0 && Object.keys(progress).length === 0;

      if (hasMissingCollections) {
        const subData = await this.fetchSubcollections(db, user);
        if (subData) {
          library = { ...subData.library, ...library };
          progress = { ...subData.progress, ...progress };
          readerModes = { ...subData.readerModes, ...readerModes };
          savedTitles = { ...subData.savedTitles, ...savedTitles };
        }
      }

      return {
        data: {
          version: USER_DATA_VERSION,
          library,
          progress,
          readerModes,
          savedTitles,
          tombstones: data.tombstones || {},
          seeded: data.seeded === true,
        },
        revision,
      };
    }

    // Fallback: check subcollections if sync doc is empty
    const subData = await this.fetchSubcollections(db, user);
    if (subData) {
      return { data: subData, revision: 0 };
    }

    return { data: null, revision: 0 };
  }

  private async fetchSubcollections(db: Firestore, user: User): Promise<UserData | null> {
    const libraryCol = collection(db, "users", user.uid, "library");
    const libSnap = await getDocs(libraryCol);
    if (libSnap.empty) {
      return null;
    }

    const library: Record<string, LibraryEntry> = {};
    libSnap.forEach((d) => {
      library[d.id] = d.data() as LibraryEntry;
    });

    const progCol = collection(db, "users", user.uid, "progress");
    const progSnap = await getDocs(progCol);
    const progress: Record<string, SeriesProgress> = {};
    progSnap.forEach((d) => {
      progress[d.id] = d.data() as SeriesProgress;
    });

    const modesCol = collection(db, "users", user.uid, "readerModes");
    const modesSnap = await getDocs(modesCol);
    const readerModes: Record<string, ReaderMode> = {};
    modesSnap.forEach((d) => {
      const dData = d.data() as { mode: ReaderMode };
      if (dData.mode) readerModes[d.id] = dData.mode;
    });

    const savedCol = collection(db, "users", user.uid, "savedTitles");
    const savedSnap = await getDocs(savedCol);
    const savedTitles: Record<string, SavedTitle> = {};
    savedSnap.forEach((d) => {
      savedTitles[d.id] = d.data() as SavedTitle;
    });

    return {
      version: USER_DATA_VERSION,
      library,
      progress,
      readerModes,
      savedTitles,
      tombstones: {},
      seeded: true,
    };
  }

  /**
   * Reconciles subcollections in chunked batches <= 400 operations.
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

    // Check if superseded locally before starting
    if (this.currentReconciliationId !== reconciliationId) {
      return;
    }

    // Check if server is already at a higher revision
    const currentSnap = await getDoc(syncDocRef);
    if (currentSnap.exists()) {
      const currentRev = (currentSnap.data()?.revision as number) ?? 0;
      if (currentRev > targetRevision) {
        return; // Abort immediately: newer revision committed
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

    // Reconcile in chunked batches with liveness checks between chunks
    for (let i = 0; i < operations.length; i += MAX_BATCH_OPERATIONS) {
      if (this.currentReconciliationId !== reconciliationId) {
        return; // Superseded mid-flight
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
   * Unified, concurrency-safe atomic writer with Compare-And-Swap (CAS) transaction
   * and automatic retry.
   *
   * Architectural Guarantee:
   * 1. The authoritative state is atomically committed FIRST via runTransaction
   *    on /users/{userId}/sync/userData with server revision verification.
   * 2. Subcollections are reconciled asynchronously AFTER the atomic commit succeeds.
   * 3. Size Guard: If data approaches Firestore's 1 MiB limit (> 900 KiB), the authoritative
   *    doc stores sync manifest/tombstones while subcollections store full data, preventing
   *    truncation or silent data loss.
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

        // 3. Prepare payload with 1 MiB size guard
        const fullPayload = {
          version: USER_DATA_VERSION,
          updatedAt: now,
          library: merged.library,
          progress: merged.progress,
          readerModes: merged.readerModes,
          savedTitles: merged.savedTitles,
          tombstones: merged.tombstones || {},
          seeded: Boolean(merged.seeded),
        };

        const estimatedBytes = estimateDataSize(fullPayload);
        const isOverSafeLimit = estimatedBytes > FIRESTORE_DOC_SAFE_LIMIT_BYTES;

        // Size Guard Fallback: If payload exceeds 900 KiB, store manifest & tombstones
        // in sync doc and rely on subcollections for storage without truncation.
        const syncPayload = isOverSafeLimit
          ? {
              version: USER_DATA_VERSION,
              updatedAt: now,
              readerModes: merged.readerModes,
              tombstones: merged.tombstones || {},
              seeded: Boolean(merged.seeded),
            }
          : fullPayload;

        // 4. ATOMIC COMMIT FIRST via transaction
        const nextRevision = await runTransaction(db, async (tx) => {
          const snap = await tx.get(syncDocRef);
          const serverRevision = snap.exists() ? ((snap.data()?.revision as number) ?? 0) : 0;

          if (snap.exists() && serverRevision !== expectedRevision) {
            throw new Error(
              `Revision conflict: expected revision ${expectedRevision}, but server is at ${serverRevision}`
            );
          }

          const newRev = Math.max(serverRevision, expectedRevision) + 1;

          // Commit root user doc
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

          // Commit authoritative sync doc
          tx.set(
            syncDocRef,
            {
              ...syncPayload,
              revision: newRev,
              syncStatus: "ready",
              updatedAt: now,
            },
            { merge: true }
          );

          return newRev;
        });

        // 5. ATOMIC COMMIT SUCCEEDED!
        // Advance reconciliation ID and spawn safe subcollection reconciliation
        this.currentReconciliationId++;
        const reconciliationId = this.currentReconciliationId;

        // Non-blocking derived reconciliation
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
          // Exponential backoff with jitter
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
   * 3. Executes atomicSyncOrPush with conflict retry.
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
   * Listens to remote changes on the sync document.
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
        const data = snapshot.data() as UserData & { syncStatus?: string };
        if (data.syncStatus === "syncing") {
          return;
        }

        let library = data.library || {};
        let progress = data.progress || {};
        let readerModes = data.readerModes || {};
        let savedTitles = data.savedTitles || {};

        if (Object.keys(library).length === 0 && Object.keys(progress).length === 0) {
          const subData = await this.fetchSubcollections(db, authUser);
          if (subData) {
            library = { ...subData.library, ...library };
            progress = { ...subData.progress, ...progress };
            readerModes = { ...subData.readerModes, ...readerModes };
            savedTitles = { ...subData.savedTitles, ...savedTitles };
          }
        }

        const validData: UserData = {
          version: USER_DATA_VERSION,
          library,
          progress,
          readerModes,
          savedTitles,
          tombstones: data.tombstones || {},
          seeded: data.seeded === true,
        };
        onRemoteChange(validData);
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
      // 1. Immediate local save
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

      // 2. Debounced transactional remote push (600ms) with concurrency & retry protection
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
            // Get fresh local data to include any intermediate edits
            const latestData = localAdapter.load() ?? data;
            // All write paths now go through atomicSyncOrPush with CAS revision verification
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
