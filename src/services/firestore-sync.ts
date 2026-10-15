import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
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

export const PRE_SYNC_BACKUP_KEY = "manga-reader:v1:pre-sync-backup";

/**
 * Pure 3-way/timestamp-based non-destructive merger for UserData.
 * Guarantees no local data is wiped when syncing with remote data.
 */
export function mergeUserData(local: UserData, remote?: Partial<UserData> | null): UserData {
  if (!remote) {
    return { ...local };
  }

  // 1. Merge Library Entries
  const mergedLibrary: Record<string, LibraryEntry> = { ...local.library };
  if (remote.library) {
    for (const [key, remoteEntry] of Object.entries(remote.library)) {
      const localEntry = mergedLibrary[key];
      if (!localEntry) {
        mergedLibrary[key] = remoteEntry;
      } else {
        // Compare addedAt timestamp
        const localTime = new Date(localEntry.addedAt || 0).getTime();
        const remoteTime = new Date(remoteEntry.addedAt || 0).getTime();
        if (remoteTime > localTime) {
          mergedLibrary[key] = remoteEntry;
        }
      }
    }
  }

  // 2. Merge Reading Progress
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

  // 3. Merge Reader Modes
  const mergedReaderModes: Record<string, ReaderMode> = {
    ...remote.readerModes,
    ...local.readerModes,
  };

  // 4. Merge Saved Titles
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
    library: mergedLibrary,
    progress: mergedProgress,
    readerModes: mergedReaderModes,
    savedTitles: mergedSavedTitles,
    seeded: Boolean(local.seeded || remote.seeded),
  };
}

class FirestoreSyncService {
  private status: SyncStatus = isFirebaseConfigured() ? "idle" : "disabled";
  private listeners = new Set<(status: SyncStatus) => void>();
  private unsubscribeSnapshot: Unsubscribe | null = null;
  private isSyncing = false;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleNetworkChange(true));
      window.addEventListener("offline", () => this.handleNetworkChange(false));
      if (!navigator.onLine && isFirebaseConfigured()) {
        this.setStatus("offline");
      }
    }
  }

  public getStatus(): SyncStatus {
    return this.status;
  }

  public subscribeStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  public setStatus(status: SyncStatus) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((l) => l(status));
  }

  private handleNetworkChange(online: boolean) {
    if (!isFirebaseConfigured()) {
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
  public preserveLocalBackup(data: UserData): void {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(PRE_SYNC_BACKUP_KEY) === null) {
        window.localStorage.setItem(PRE_SYNC_BACKUP_KEY, JSON.stringify(data));
      }
    } catch (e) {
      console.warn("Failed to preserve pre-sync backup:", e);
    }
  }

  /**
   * Pulls remote data from Firestore for the given user.
   */
  public async fetchRemoteData(db: Firestore, user: User): Promise<UserData | null> {
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    const syncSnap = await getDoc(syncDocRef);

    if (syncSnap.exists()) {
      const data = syncSnap.data() as UserData;
      return {
        version: USER_DATA_VERSION,
        library: data.library || {},
        progress: data.progress || {},
        readerModes: data.readerModes || {},
        savedTitles: data.savedTitles || {},
        seeded: data.seeded === true,
      };
    }

    // Check subcollections fallback if sync doc is empty
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
        const data = d.data() as { mode: ReaderMode };
        if (data.mode) readerModes[d.id] = data.mode;
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
        seeded: true,
      };
    }

    return null;
  }

  /**
   * Uploads user data to Firestore subcollections and sync aggregate doc.
   */
  public async uploadUserData(db: Firestore, user: User, data: UserData): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = user.metadata?.creationTime
      ? new Date(user.metadata.creationTime).toISOString()
      : now;
    const batch = writeBatch(db);

    // 1. Root user doc
    const userDocRef = doc(db, "users", user.uid);
    batch.set(
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

    // 2. Aggregate sync doc
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    batch.set(syncDocRef, {
      ...data,
      updatedAt: now,
    });

    // 3. Subcollection documents
    for (const [key, entry] of Object.entries(data.library)) {
      const ref = doc(db, "users", user.uid, "library", key);
      const title = data.savedTitles[key]?.title || key;
      batch.set(
        ref,
        {
          seriesId: key,
          mediaId: key,
          title,
          status: entry.status,
          addedAt: entry.addedAt || now,
          updatedAt: entry.addedAt || now,
        },
        { merge: true }
      );
    }

    for (const [key, prog] of Object.entries(data.progress)) {
      const ref = doc(db, "users", user.uid, "progress", key);
      batch.set(
        ref,
        {
          seriesId: key,
          lastChapterId: prog.lastChapterId,
          updatedAt: prog.updatedAt || now,
          chapters: prog.chapters || {},
        },
        { merge: true }
      );
    }

    for (const [key, mode] of Object.entries(data.readerModes)) {
      const ref = doc(db, "users", user.uid, "readerModes", key);
      batch.set(ref, { seriesId: key, mode, updatedAt: now }, { merge: true });
    }

    for (const [key, title] of Object.entries(data.savedTitles)) {
      const ref = doc(db, "users", user.uid, "savedTitles", key);
      batch.set(
        ref,
        {
          ...title,
          id: key,
          mediaId: key,
          savedAt: title.fetchedAt || now,
        },
        { merge: true }
      );
    }

    await batch.commit();
  }

  /**
   * Synchronizes local user data with remote Firestore:
   * 1. Preserves local backup.
   * 2. Fetches remote data.
   * 3. Merges remote + local non-destructively.
   * 4. Uploads merged state to Firestore.
   * 5. Returns merged data to be applied to the local store.
   */
  public async syncWithRemote(localData: UserData): Promise<UserData> {
    if (!isFirebaseConfigured() || typeof window === "undefined") {
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
      this.preserveLocalBackup(localData);

      const user = await ensureAnonymousUser();
      if (!user) {
        throw new Error("Could not authenticate anonymous user");
      }

      const db = getFirebaseFirestore();
      if (!db) {
        throw new Error("Firestore is not available");
      }

      // Fetch remote
      const remoteData = await this.fetchRemoteData(db, user);

      // Non-destructive merge
      const merged = mergeUserData(localData, remoteData);

      // Upload merged changes back
      await this.uploadUserData(db, user, merged);

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
    if (!isFirebaseConfigured() || typeof window === "undefined") {
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
        const data = snapshot.data() as UserData;
        const validData: UserData = {
          version: USER_DATA_VERSION,
          library: data.library || {},
          progress: data.progress || {},
          readerModes: data.readerModes || {},
          savedTitles: data.savedTitles || {},
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
 * cache while transparently synchronizing changes with Cloud Firestore when available.
 */
export function createSyncedPersistenceAdapter(
  localAdapter: PersistenceAdapter = createLocalStorageAdapter()
): PersistenceAdapter {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let externalChangeCallback: (() => void) | null = null;
  let hasInitiatedSync = false;

  return {
    getWarning: () => localAdapter.getWarning?.(),
    getRecovery: () => localAdapter.getRecovery?.(),
    load() {
      const local = localAdapter.load();
      if (!hasInitiatedSync && typeof window !== "undefined" && isFirebaseConfigured()) {
        hasInitiatedSync = true;
        const currentData = local ?? emptyUserData();
        syncService
          .syncWithRemote(currentData)
          .then((merged) => {
            localAdapter.save(merged);
            externalChangeCallback?.();
          })
          .catch((err) => {
            console.warn("Initial background sync failed:", err);
          });
      }
      return local;
    },
    save(data: UserData) {
      // 1. Immediate local save
      localAdapter.save(data);

      if (!isFirebaseConfigured() || typeof window === "undefined") {
        return;
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
            await syncService.uploadUserData(db, user, data);
            syncService.setStatus("synced");
          }
        } catch (err) {
          console.warn("Background upload failed:", err);
          syncService.setStatus(navigator.onLine ? "error" : "offline");
        }
      }, 600);
    },
    subscribe(onExternalChange: () => void) {
      externalChangeCallback = onExternalChange;
      const unsubscribeLocal = localAdapter.subscribe?.(onExternalChange) ?? (() => {});
      const unsubscribeRemote = syncService.listenToRemote((remoteData) => {
        const local = localAdapter.load() ?? emptyUserData();
        const merged = mergeUserData(local, remoteData);
        localAdapter.save(merged);
        onExternalChange();
      });

      return () => {
        externalChangeCallback = null;
        unsubscribeLocal();
        unsubscribeRemote();
      };
    },
  };
}

