import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import type { UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import { isCloudSyncEnabled, setCloudSyncEnabled, subscribeCloudSyncPreference, CLOUD_SYNC_OPT_IN_KEY } from "./cloud-sync-preference";
import { isFirebaseConfigured } from "./firebase-config";
import { getFirebaseFirestore } from "./firebase";
import { ensureAnonymousUser, subscribeToAuthState } from "./firebase-auth";
import { createLocalStorageAdapter, type PersistenceAdapter } from "./persistence";
import { mergeUserData } from "./sync-merge";
import { publishSyncState, type SyncStatus } from "./sync-status-bridge";
import {
  ChunkedOperation,
  MAX_BATCH_OPERATIONS,
  RemoteDataUnrecoverableError,
  RevisionConflictError,
  buildSnapshotPayload,
  canonicalStringify,
  deleteSnapshotTree,
  estimateDataSize,
  loadRemoteState,
  pruneObsoleteSnapshots,
  stageAndVerifySnapshot,
  validateRecordSizeGuards,
  type RemoteState,
} from "./sync-snapshot";

export { mergeUserData } from "./sync-merge";
export {
  FIRESTORE_DOC_MAX_BYTES,
  FIRESTORE_DOC_SAFE_LIMIT_BYTES,
  FIRESTORE_RECORD_SAFE_LIMIT_BYTES,
  MAX_BATCH_OPERATIONS,
  RemoteDataUnrecoverableError,
  RemoteVersionError,
  RevisionConflictError,
  SnapshotVerificationError,
  buildSnapshotPayload,
  canonicalStringify,
  commitChunkedBatches,
  computeDataChecksum,
  estimateDataSize,
  generateSnapshotId,
  getClientSessionId,
  loadRemoteState,
  partitionPayload,
  pruneObsoleteSnapshots,
  readVerifiedSnapshot,
  setClientSessionId,
  stageAndVerifySnapshot,
  validateRecordSizeGuards,
  type ChunkedOperation,
  type RemoteState,
  type SnapshotManifest,
  type StagedSnapshotDoc,
  type StagedSnapshotPartDoc,
} from "./sync-snapshot";

export { CLOUD_SYNC_OPT_IN_KEY, isCloudSyncEnabled, setCloudSyncEnabled };
export type { SyncStatus } from "./sync-status-bridge";

export const PRE_SYNC_BACKUP_KEY = "manga-reader:v1:pre-sync-backup";

/**
 * The per-collection mirrors (library, progress, readerModes, savedTitles) are
 * written from the snapshot but nothing in the app reads them. They cost one
 * write per record per sync, so they are off. The snapshot is the single source
 * of truth. See docs/firebase-sync-architecture.md before turning this on.
 */
export const SECONDARY_REPLICAS_ENABLED = false;

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
      return parsed !== null && typeof parsed === "object" && parsed.version === USER_DATA_VERSION;
    }
    window.localStorage.setItem(PRE_SYNC_BACKUP_KEY, JSON.stringify(data));
    const readBack = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    if (!readBack) return false;
    const parsed = JSON.parse(readBack);
    return parsed !== null && typeof parsed === "object" && parsed.version === USER_DATA_VERSION;
  } catch (e) {
    console.warn("Pre-sync backup verification failed:", e);
    return false;
  }
}

export type SyncOutcome =
  | { ok: true; data: UserData; recoveredFrom?: { snapshotId: string; reason: string } }
  | { ok: false; reason: "disabled" | "offline" | "error"; data: UserData; error?: Error };

type MergedListener = (merged: UserData) => void;

/** Thrown inside a run when the user disables cloud sync while it is in progress. */
export class SyncDisabledError extends Error {
  constructor() {
    super("Cloud sync was turned off.");
    this.name = "SyncDisabledError";
  }
}

class FirestoreSyncService {
  private status: SyncStatus = isFirebaseConfigured() && isCloudSyncEnabled() ? "idle" : "disabled";
  private listeners = new Set<(status: SyncStatus) => void>();
  private mergedListeners = new Set<MergedListener>();
  /** Monotonic local ID to invalidate delayed or obsolete subcollection reconciliations */
  private currentReconciliationId = 0;
  /** Highest revision this tab has published or read; used to ignore its own echoes. */
  private lastKnownRevision = 0;
  /** The account `lastKnownRevision` belongs to; revisions are per account, so a switch resets it. */
  private revisionUid: string | null = null;
  private lastNotice: string | undefined;
  private lastRecoveredFrom: { snapshotId: string; reason: string } | undefined;
  // Single-flight queue: one sync runs at a time; requests made meanwhile coalesce into one follow-up.
  private tail: Promise<unknown> = Promise.resolve();
  private queued: { getLocal: () => UserData; promise: Promise<SyncOutcome> } | null = null;
  private running = false;
  /** Settles when the latest publication transaction does; lets the listener tell echoes of our own write from other devices'. */
  private publishing: Promise<unknown> = Promise.resolve();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleNetworkChange(true));
      window.addEventListener("offline", () => this.handleNetworkChange(false));
      if (!navigator.onLine && isFirebaseConfigured() && isCloudSyncEnabled()) this.setStatus("offline");
    }
  }

  private trackAccount(uid: string) {
    if (this.revisionUid === uid) return;
    this.revisionUid = uid;
    this.lastKnownRevision = 0;
  }

  /** Settles once the sync queue is empty (used before switching accounts). */
  public async whenIdle(): Promise<void> {
    let tail: Promise<unknown>;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  public getStatus(): SyncStatus {
    if (!isFirebaseConfigured() || !isCloudSyncEnabled()) return "disabled";
    return this.status;
  }

  /** Last recovery or failure explanation, for the status indicator. */
  public getNotice(): string | undefined {
    return this.lastNotice;
  }

  public subscribeStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  /** Called with the merged result after every successful sync, whoever triggered it. */
  public subscribeMerged(listener: MergedListener): () => void {
    this.mergedListeners.add(listener);
    return () => this.mergedListeners.delete(listener);
  }

  public setStatus(status: SyncStatus) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((l) => l(status));
    publishSyncState({ status });
  }

  private handleNetworkChange(online: boolean) {
    if (!isFirebaseConfigured() || !isCloudSyncEnabled()) {
      this.setStatus("disabled");
      return;
    }
    if (!online) this.setStatus("offline");
    else if (this.status === "offline") this.setStatus("idle");
  }

  public preserveLocalBackup(data: UserData): boolean {
    return createAndVerifyLocalBackup(data);
  }

  /** Verified remote state, recovering from an earlier snapshot if the active one is corrupt. */
  public fetchRemoteData(db: Firestore, user: { uid: string }): Promise<RemoteState> {
    return loadRemoteState(db, user);
  }

  /**
   * Optional per-collection mirrors. Disabled by SECONDARY_REPLICAS_ENABLED. When
   * enabled they run after publication and can never overwrite a newer revision.
   */
  public async reconcileSubcollections(
    db: Firestore,
    user: { uid: string },
    reconciliationId: number,
    targetRevision: number,
    data: UserData,
  ): Promise<void> {
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");
    if (this.currentReconciliationId !== reconciliationId) return;

    const currentSnap = await getDoc(syncDocRef);
    if (currentSnap.exists() && ((currentSnap.data()?.revision as number) ?? 0) > targetRevision) return;

    const now = new Date().toISOString();
    const operations: ChunkedOperation[] = [];
    for (const [key, entry] of Object.entries(data.library)) {
      operations.push({
        type: "set",
        ref: doc(db, "users", user.uid, "library", key),
        data: {
          seriesId: key,
          mediaId: key,
          title: data.savedTitles[key]?.title || key,
          status: entry.status,
          addedAt: entry.addedAt || now,
          updatedAt: entry.updatedAt || entry.addedAt || now,
        },
        options: { merge: true },
      });
    }
    for (const id of Object.keys(data.tombstones || {})) {
      if (!data.library[id]) operations.push({ type: "delete", ref: doc(db, "users", user.uid, "library", id) });
    }
    for (const [key, prog] of Object.entries(data.progress)) {
      operations.push({
        type: "set",
        ref: doc(db, "users", user.uid, "progress", key),
        data: { seriesId: key, lastChapterId: prog.lastChapterId, updatedAt: prog.updatedAt || now, chapters: prog.chapters || {} },
        options: { merge: true },
      });
    }
    for (const [key, mode] of Object.entries(data.readerModes)) {
      operations.push({
        type: "set",
        ref: doc(db, "users", user.uid, "readerModes", key),
        data: { seriesId: key, mode, updatedAt: data.readerModeTimes?.[key] || now },
        options: { merge: true },
      });
    }
    for (const [key, title] of Object.entries(data.savedTitles)) {
      operations.push({
        type: "set",
        ref: doc(db, "users", user.uid, "savedTitles", key),
        data: { ...title, id: key, mediaId: key, savedAt: title.fetchedAt || now },
        options: { merge: true },
      });
    }
    for (let i = 0; i < operations.length; i += MAX_BATCH_OPERATIONS) {
      if (this.currentReconciliationId !== reconciliationId) return;
      const batch = writeBatch(db);
      for (const op of operations.slice(i, i + MAX_BATCH_OPERATIONS)) {
        if (op.type === "set") batch.set(op.ref, op.data, op.options);
        else batch.delete(op.ref);
      }
      await batch.commit();
    }
  }

  /**
   * One concurrency-safe write cycle (staged immutable snapshot, then CAS publication):
   * 1. Read the verified remote state (never a partial one; throws if unrecoverable).
   * 2. Merge deterministically with local data.
   * 3. Stage and verify a complete immutable snapshot.
   * 4. Publish `activeSnapshotId` + `revision` in a transaction that fails if the
   *    revision moved; the losing snapshot is deleted and the cycle retried.
   * 5. Prune old snapshots (with their parts) in the background.
   */
  public async atomicSyncOrPush(
    db: Firestore,
    user: { uid: string; isAnonymous?: boolean; metadata?: { creationTime?: string } },
    localData: UserData,
    maxRetries = 3,
    /** Checked before each cloud write; the sync run passes "is cloud sync still on?". */
    mayContinue: () => boolean = () => true,
  ): Promise<UserData> {
    const userDocRef = doc(db, "users", user.uid);
    const syncDocRef = doc(db, "users", user.uid, "sync", "userData");

    this.trackAccount(user.uid);
    for (let attempt = 0; ; attempt++) {
      // Turning cloud sync off stops any further cloud operation, even in the middle of a run.
      if (!mayContinue()) throw new SyncDisabledError();
      const now = new Date().toISOString();
      const createdAt = user.metadata?.creationTime ? new Date(user.metadata.creationTime).toISOString() : now;
      const remote = await this.fetchRemoteData(db, user); // throws RemoteDataUnrecoverableError: nothing is published
      this.lastRecoveredFrom = remote.recoveredFrom;
      const expectedRevision = remote.revision;
      const merged = mergeUserData(localData, remote.data);
      validateRecordSizeGuards(merged);

      const snapshot = await stageAndVerifySnapshot(db, user, expectedRevision + 1, merged);
      try {
        if (!mayContinue()) throw new SyncDisabledError(); // staged copy is removed below; nothing is published
        const publication = runTransaction(db, async (tx) => {
          const current = await tx.get(syncDocRef);
          const serverRevision = current.exists() ? ((current.data()?.revision as number) ?? 0) : 0;
          if (serverRevision !== expectedRevision) throw new RevisionConflictError(expectedRevision, serverRevision);
          const revision = expectedRevision + 1;
          tx.set(userDocRef, { uid: user.uid, createdAt, updatedAt: now, version: USER_DATA_VERSION, anonymous: user.isAnonymous ?? false }, { merge: true });
          tx.set(syncDocRef, {
            revision,
            activeSnapshotId: snapshot.snapshotId,
            snapshotChecksum: snapshot.checksum,
            snapshotParts: snapshot.totalParts,
            syncStatus: "ready",
            updatedAt: now,
            version: USER_DATA_VERSION,
            manifest: {
              totalLibrary: Object.keys(merged.library).length,
              totalProgress: Object.keys(merged.progress).length,
              totalSavedTitles: Object.keys(merged.savedTitles).length,
              snapshotBytes: estimateDataSize(buildSnapshotPayload(merged)),
            },
          });
          return revision;
        });
        this.publishing = publication.catch(() => undefined);
        const nextRevision = await publication;

        this.lastKnownRevision = Math.max(this.lastKnownRevision, nextRevision);
        this.currentReconciliationId++;
        const reconciliationId = this.currentReconciliationId;
        void pruneObsoleteSnapshots(db, user, nextRevision, snapshot.snapshotId);
        if (SECONDARY_REPLICAS_ENABLED) {
          this.reconcileSubcollections(db, user, reconciliationId, nextRevision, merged).catch((err) => {
            console.warn("Background subcollection reconciliation failed:", err);
          });
        }
        return merged;
      } catch (error) {
        // The staged snapshot was never published; remove it so it cannot linger.
        await deleteSnapshotTree(db, user, snapshot.snapshotId, snapshot.totalParts).catch(() => undefined);
        const conflict = error instanceof RevisionConflictError;
        if (conflict && attempt < maxRetries) {
          const delayMs = Math.min(100 * Math.pow(2, attempt + 1) + Math.random() * 50, 1000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Queue one synchronization. Only one runs at a time in this tab; a request made
   * while one is running joins a single follow-up run that reads the freshest local
   * data when it starts, so nothing overlaps and nothing is dropped.
   */
  public syncNow(getLocal: () => UserData): Promise<SyncOutcome> {
    if (this.queued) {
      this.queued.getLocal = getLocal;
      return this.queued.promise;
    }
    const entry: { getLocal: () => UserData; promise: Promise<SyncOutcome> } = {
      getLocal,
      promise: undefined as unknown as Promise<SyncOutcome>,
    };
    entry.promise = this.tail.then(() => {
      this.queued = null;
      return this.execute(entry.getLocal);
    });
    this.queued = entry;
    this.tail = entry.promise.catch(() => undefined);
    return entry.promise;
  }

  private setNotice(notice: string | undefined) {
    this.lastNotice = notice;
    publishSyncState({ notice });
  }

  private takeRecovery() {
    return this.lastRecoveredFrom;
  }

  /** True while a synchronization is executing in this tab. */
  public isBusy(): boolean {
    return this.running;
  }

  private async execute(getLocal: () => UserData): Promise<SyncOutcome> {
    const local = getLocal();
    if (!isFirebaseConfigured() || typeof window === "undefined" || !isCloudSyncEnabled()) {
      this.setStatus("disabled");
      return { ok: false, reason: "disabled", data: local };
    }
    if (!navigator.onLine) {
      this.setStatus("offline");
      return { ok: false, reason: "offline", data: local };
    }
    this.running = true;
    this.setStatus("syncing");
    try {
      if (!this.preserveLocalBackup(local)) {
        throw new Error("Local backup verification failed. Cloud sync aborted for data safety.");
      }
      const user = await ensureAnonymousUser();
      if (!user) throw new Error("Could not authenticate with Firebase");
      const db = getFirebaseFirestore();
      if (!db) throw new Error("Firestore is not available");

      this.lastRecoveredFrom = undefined;
      const merged = await this.atomicSyncOrPush(db, user, local, 3, isCloudSyncEnabled);
      const recoveredFrom = this.takeRecovery();
      this.setNotice(
        recoveredFrom
          ? `Cloud copy was damaged and was restored from an earlier snapshot (${recoveredFrom.snapshotId}). Your local data was kept and merged.`
          : undefined,
      );
      this.setStatus("synced");
      this.mergedListeners.forEach((listener) => listener(merged));
      return { ok: true, data: merged, recoveredFrom };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof SyncDisabledError || !isCloudSyncEnabled()) {
        this.setStatus("disabled");
        return { ok: false, reason: "disabled", data: local };
      }
      console.warn("Firestore sync failed:", error);
      this.setNotice(error instanceof RemoteDataUnrecoverableError ? error.message : undefined);
      const offline = !navigator.onLine;
      this.setStatus(offline ? "offline" : "error");
      return { ok: false, reason: offline ? "offline" : "error", data: local, error };
    } finally {
      this.running = false;
    }
  }

  /** Compatibility wrapper used by the UI; returns local data unchanged on failure. */
  public async syncWithRemote(localData: UserData): Promise<UserData> {
    return (await this.syncNow(() => localData)).data;
  }

  /**
   * Listens for changes made elsewhere. Attaches once a user is signed in (and
   * again if the user or the opt-in changes), so it works from a cold start.
   * Ignores echoes of this tab's own writes and never applies unverified data.
   */
  public listenToRemote(onRemoteChange: (remoteData: UserData) => void): () => void {
    let detach: Unsubscribe | null = null;
    let disposed = false;
    let currentUser: { uid: string } | null = null;
    let chain: Promise<unknown> = Promise.resolve();

    const attach = () => {
      detach?.();
      detach = null;
      const db = getFirebaseFirestore();
      if (disposed || !db || !currentUser || !isFirebaseConfigured() || !isCloudSyncEnabled()) return;
      const user = currentUser;
      this.trackAccount(user.uid);
      detach = onSnapshot(
        doc(db, "users", user.uid, "sync", "userData"),
        (snapshot) => {
          if (!snapshot.exists() || snapshot.metadata.hasPendingWrites) return;
          const revision = (snapshot.data()?.revision as number) ?? 0;
          if (revision <= this.lastKnownRevision) return;
          chain = chain.then(async () => {
            try {
              await this.publishing; // our own publication, if any, finishes (and is recorded) first
              if (revision <= this.lastKnownRevision) return; // echo of this tab's own write
              if (!isCloudSyncEnabled()) return;
              const remote = await this.fetchRemoteData(db, user);
              this.lastKnownRevision = Math.max(this.lastKnownRevision, remote.revision);
              if (remote.data) onRemoteChange(remote.data);
            } catch (error) {
              console.warn("Could not apply remote change:", error);
              this.setNotice(error instanceof RemoteDataUnrecoverableError ? error.message : undefined);
              this.setStatus(navigator.onLine ? "error" : "offline");
            }
          });
        },
        (error) => {
          console.warn("Remote snapshot listener error:", error);
          this.setStatus(navigator.onLine ? "error" : "offline");
        },
      );
    };

    const unsubscribeAuth = subscribeToAuthState((user) => {
      currentUser = user;
      attach();
    });
    const unsubscribePreference = subscribeCloudSyncPreference(attach);
    return () => {
      disposed = true;
      unsubscribePreference();
      unsubscribeAuth();
      detach?.();
      detach = null;
    };
  }
}

export const syncService = new FirestoreSyncService();

/** Exposed for tests that need an isolated service instance. */
export { FirestoreSyncService };

/**
 * Persistence adapter: localStorage stays the synchronous source for the app,
 * and cloud sync (only when configured and the user opted in) runs behind it.
 * Every sync goes through the service's single-flight queue, reads the freshest
 * local data when it starts, and is applied by merging into whatever is stored
 * at that moment, so edits made during a sync are never overwritten.
 */
export function createSyncedPersistenceAdapter(
  localAdapter: PersistenceAdapter = createLocalStorageAdapter(),
  service: FirestoreSyncService = syncService,
  debounceMs = 600,
): PersistenceAdapter {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let externalChangeCallback: (() => void) | null = null;
  let hasInitiatedSync = false;

  const readLocal = (): UserData => localAdapter.load() ?? emptyUserData();
  const syncEnabled = () => typeof window !== "undefined" && isFirebaseConfigured() && isCloudSyncEnabled();
  /** Never sync from storage that could not be read: it would look empty. */
  const localIsReadable = () => !localAdapter.getWarning?.();

  const applyIncoming = (incoming: UserData) => {
    const current = readLocal();
    const next = mergeUserData(current, incoming);
    if (canonicalStringify(next) === canonicalStringify(current)) return;
    localAdapter.save(next);
    externalChangeCallback?.();
  };
  service.subscribeMerged(applyIncoming);

  const runSync = () => {
    if (!syncEnabled() || !localIsReadable()) return;
    void service.syncNow(readLocal);
  };

  return {
    getWarning: () => localAdapter.getWarning?.(),
    getRecovery: () => localAdapter.getRecovery?.(),
    load() {
      const local = localAdapter.load();
      if (!hasInitiatedSync && syncEnabled()) {
        hasInitiatedSync = true;
        if (localIsReadable()) void service.syncNow(readLocal);
      }
      return local;
    },
    save(data: UserData) {
      localAdapter.save(data);
      if (!syncEnabled()) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSync, debounceMs);
    },
    subscribe(onExternalChange: () => void) {
      externalChangeCallback = onExternalChange;
      const unsubscribeLocal = localAdapter.subscribe?.(onExternalChange) ?? (() => {});
      const unsubscribeRemote = service.listenToRemote(applyIncoming);
      return () => {
        externalChangeCallback = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        unsubscribeLocal();
        unsubscribeRemote();
      };
    },
  };
}
