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

  /**
   * Preserves local pre-sync backup in browser storage before initial sync.
   */
  public preserveLocalBackup(data: UserData): boolean {
    return createAndVerifyLocalBackup(data);
  }

  /**
   * Pulls remote data from Firestore for the given user, returning the data and its revision.
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
      return {
        data: {
          version: USER_DATA_VERSION,
          library: data.library || {},
          progress: data.progress || {},
          readerModes: data.readerModes || {},
          savedTitles: data.savedTitles || {},
          tombstones: data.tombstones || {},
          seeded: data.seeded === true,
        },
        revision,
      };
    }

    // Fallback: check subcollections if sync doc is empty
    const libraryCol = collection(db, "users", user.uid, "library");
    const libSnap = await getDocs(libraryCol);
    if (!libSnap.empty) {
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
        data: {
          version: USER_DATA_VERSION,
          library,
          progress,
          readerModes,
          savedTitles,
          tombstones: {},
          seeded: true,
        },
        revision: 0,
      };
    }

    return { data: null, revision: 0 };
  }

  /**
   * Uploads subcollections using chunked batches <= 400 operations,
   * then atomically updates the aggregate sync doc via a transaction with revision check.
   */
  public async uploadUserData(
    db: Firestore,
    user: User,
    data: UserData,
    expectedRevision = 0
  ): Promise<number> {
    const now = new Date().toISOString();
    const createdAt = user.metadata?.creationTime
      ? new Date(user.metadata.creationTime).toISOString()
      : now;

    // Collect subcollection batch operations
    const operations: ChunkedOperation[] = [];

    // 1. Root user doc
    operations.push({
      type: "set",
      ref: doc(db, "users", user.uid),
      data: {
        uid: user.uid,
        createdAt,
        updatedAt: now,
        version: USER_DATA_VERSION,
        anonymous: user.isAnonymous,
      },
      options: { merge: true },
    });

    // 2. Library subcollection: add/update existing
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

    // 3. Library subcollection: delete tombstoned entries
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

    // 4. Progress subcollection
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

    // 5. Reader modes subcollection
    for (const [key, mode] of Object.entries(data.readerModes)) {
      const ref = doc(db, "users", user.uid, "readerModes", key);
      operations.push({
        type: "set",
        ref,
        data: { seriesId: key, mode, updatedAt: now },
        options: { merge: true },
      });
    }

    // 6. Saved titles subcollection
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

    // Commit subcollection batches in chunks of <= 400
    await commitChunkedBatches(db, operations);

    // 7. Atomic sync document commit via transaction
    // This serves as the atomic commit marker: the sync is marked "ready" only
    // after all chunked batches have safely completed.
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    const newRevision = await runTransaction(db, async (tx) => {
      const snap = await tx.get(syncDocRef);
      const serverRevision = snap.exists() ? ((snap.data()?.revision as number) ?? 0) : 0;
      if (expectedRevision > 0 && snap.exists() && serverRevision !== expectedRevision) {
        throw new Error(
          `Revision conflict: expected revision ${expectedRevision}, but server is at ${serverRevision}`
        );
      }
      const nextRevision = Math.max(serverRevision, expectedRevision) + 1;
      tx.set(
        syncDocRef,
        {
          ...data,
          revision: nextRevision,
          syncStatus: "ready",
          updatedAt: now,
        },
        { merge: true }
      );
      return nextRevision;
    });

    return newRevision;
  }

  /**
   * Synchronizes local user data with remote Firestore:
   * 1. Requires explicit user opt-in (`isCloudSyncEnabled`).
   * 2. Verifies local backup is recoverable before any network writes.
   * 3. Fetches remote data and revision.
   * 4. Non-destructively merges with tombstones.
   * 5. Atomically commits changes with server revision check.
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
      // Data safety check: verify recoverable local backup exists
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

      // Fetch remote
      const { data: remoteData, revision: currentRevision } = await this.fetchRemoteData(db, user);

      // Non-destructive merge
      const merged = mergeUserData(localData, remoteData);

      // Upload merged changes back with concurrency protection
      await this.uploadUserData(db, user, merged, currentRevision);

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
      (snapshot) => {
        if (!snapshot.exists() || snapshot.metadata.hasPendingWrites) {
          return;
        }
        const data = snapshot.data() as UserData & { syncStatus?: string };
        // Ignore in-progress writes from another batch that haven't finished
        if (data.syncStatus === "syncing") {
          return;
        }

        const validData: UserData = {
          version: USER_DATA_VERSION,
          library: data.library || {},
          progress: data.progress || {},
          readerModes: data.readerModes || {},
          savedTitles: data.savedTitles || {},
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
              // Local changes occurred during network sync: merge against fresh local data
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

      // 2. Debounced remote push (600ms)
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
            await syncService.uploadUserData(db, user, latestData);
            syncService.setStatus("synced");
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
