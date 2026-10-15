import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserData } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import { fake } from "@/test/fake-firestore";
import { DB, TEST_USER, library } from "@/test/sync-fixtures";

const auth = vi.hoisted(() => {
  const subscribers = new Set<(user: unknown) => void>();
  return {
    user: null as unknown,
    subscribers,
    setUser(user: unknown) { this.user = user; subscribers.forEach((cb) => cb(user)); },
  };
});

vi.mock("firebase/firestore", async () => (await import("@/test/fake-firestore")).firestoreModule);
vi.mock("./firebase-config", () => ({ isFirebaseConfigured: () => true, getFirebaseConfigFromEnv: () => ({}) }));
vi.mock("./firebase", () => ({ getFirebaseFirestore: () => ({}), getFirebaseAuth: () => ({}) }));
vi.mock("./firebase-auth", () => ({
  ensureAnonymousUser: async () => auth.user,
  getCurrentUser: () => auth.user,
  subscribeToAuthState: (cb: (user: unknown) => void) => {
    auth.subscribers.add(cb);
    cb(auth.user);
    return () => auth.subscribers.delete(cb);
  },
}));

import {
  CLOUD_SYNC_OPT_IN_KEY,
  FirestoreSyncService,
  PRE_SYNC_BACKUP_KEY,
  RemoteDataUnrecoverableError,
  canonicalStringify,
  createSyncedPersistenceAdapter,
  loadRemoteState,
  setCloudSyncEnabled,
} from "./firestore-sync";
import type { PersistenceAdapter } from "./persistence";

const POINTER = "users/u1/sync/userData";
const optIn = () => localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, "true");
const online = (value: boolean) => vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

let service: FirestoreSyncService;
beforeEach(() => {
  fake.reset();
  auth.user = TEST_USER;
  auth.subscribers.clear();
  optIn();
  service = new FirestoreSyncService();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("only one synchronization runs at a time in a tab", () => {
  it("serialises overlapping requests and folds the rest into one follow-up that uses the freshest local data", async () => {
    const state = { active: 0, max: 0, locals: [] as UserData[] };
    vi.spyOn(service, "atomicSyncOrPush").mockImplementation(async (_db, _user, local) => {
      state.active++;
      state.max = Math.max(state.max, state.active);
      state.locals.push(local);
      await tick(20);
      state.active--;
      return local;
    });
    const getters = [1, 2, 3, 4, 5].map((n) => () => library(n));
    const promises = [service.syncNow(getters[0]!)];
    await tick(2); // the first run is now in progress
    expect(service.isBusy()).toBe(true);
    promises.push(...getters.slice(1).map((get) => service.syncNow(get)));
    expect(promises[2]).toBe(promises[1]); // everything after the running one joins the same follow-up
    expect(promises[4]).toBe(promises[1]);
    const outcomes = await Promise.all(promises);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(state.max).toBe(1); // never overlapped
    expect(state.locals).toHaveLength(2); // the first run plus a single follow-up
    expect(Object.keys(state.locals[0]!.library)).toHaveLength(1);
    expect(Object.keys(state.locals[1]!.library)).toHaveLength(5); // freshest request wins
    expect(service.isBusy()).toBe(false);
  });

  it("a request arriving after everything finished starts a new run, and a failing run does not block the queue", async () => {
    const spy = vi.spyOn(service, "atomicSyncOrPush");
    spy.mockRejectedValueOnce(new Error("boom"));
    expect((await service.syncNow(() => library(1))).ok).toBe(false);
    expect(service.getStatus()).toBe("error");
    spy.mockImplementation(async (_d, _u, local) => local);
    expect((await service.syncNow(() => library(2))).ok).toBe(true);
    expect(service.getStatus()).toBe("synced");
  });

  it("real overlapping syncs from one tab never create a conflict or orphan", async () => {
    await Promise.all([1, 2, 3, 4].map((n) => service.syncNow(() => library(n, n * 10))));
    expect(fake.counters.txRetries).toBe(0);
    expect(fake.docs.get(POINTER)!.data.revision).toBeLessThanOrEqual(2);
    expect(Object.keys((await loadRemoteState(DB, TEST_USER)).data!.library).length).toBeGreaterThanOrEqual(1);
  });
});

describe("offline, disabled and unsafe-to-sync states", () => {
  it("makes no network calls while offline, then syncs once back online", async () => {
    const spy = online(false);
    const outcome = await service.syncNow(() => library(2));
    expect(outcome).toMatchObject({ ok: false, reason: "offline" });
    expect(service.getStatus()).toBe("offline");
    expect(fake.counters).toMatchObject({ docReads: 0, docWrites: 0, transactions: 0 });
    spy.mockReturnValue(true);
    expect((await service.syncNow(() => library(2))).ok).toBe(true);
    expect(fake.docs.get(POINTER)!.data.revision).toBe(1);
  });

  it("an interrupted sync leaves local data and the remote pointer unchanged and recovers on the next attempt", async () => {
    const local = library(3);
    const snapshot = canonicalStringify(local);
    let first = true;
    fake.interceptors.push((op) => { if (op === "txCommit" && first) { first = false; throw new Error("connection lost"); } });
    const failed = await service.syncNow(() => local);
    expect(failed.ok).toBe(false);
    expect(failed.data).toBe(local);
    expect(canonicalStringify(local)).toBe(snapshot);
    expect(fake.docs.has(POINTER)).toBe(false);
    expect(fake.paths("users/u1/snapshots/")).toEqual([]);
    expect((await service.syncNow(() => local)).ok).toBe(true);
  });

  it("does nothing unless the user opted in", async () => {
    localStorage.clear();
    expect(await service.syncNow(() => library(2))).toMatchObject({ ok: false, reason: "disabled" });
    expect(service.getStatus()).toBe("disabled");
    expect(fake.counters.docReads + fake.counters.docWrites).toBe(0);
  });

  it("aborts before any cloud write if the local backup cannot be verified", async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === PRE_SYNC_BACKUP_KEY) throw new Error("quota");
      return original.call(this, key, value);
    });
    const outcome = await service.syncNow(() => library(2));
    expect(outcome).toMatchObject({ ok: false, reason: "error" });
    expect((outcome as { error?: Error }).error?.message).toMatch(/backup verification failed/);
    expect(fake.counters.docWrites + fake.counters.transactions).toBe(0);
  });

  it("notifies listeners with the merged result only after a successful sync", async () => {
    const listener = vi.fn();
    service.subscribeMerged(listener);
    await fake.seed("users/u1/other", {});
    const result = await service.syncNow(() => library(2));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toEqual(result.data);
  });

  it("signing in to a Google account that already has cloud data merges this device's library into it and leaves the abandoned anonymous copy alone", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(2, 0)); // anonymous account's copy
    const anonymousDocs = canonicalStringify([...fake.docs.entries()].filter(([p]) => p.startsWith("users/u1/")));
    const google = { uid: "g1", isAnonymous: false, metadata: { creationTime: "2025-01-01T00:00:00.000Z" } };
    await new FirestoreSyncService().atomicSyncOrPush(DB, google, library(3, 100)); // account from the other device
    const merged = await new FirestoreSyncService().atomicSyncOrPush(DB, google, library(2, 0)); // this device's local library
    expect(Object.keys(merged.library).sort()).toEqual(["al-0", "al-1", "al-100", "al-101", "al-102"]);
    expect(canonicalStringify([...fake.docs.entries()].filter(([p]) => p.startsWith("users/u1/")))).toBe(anonymousDocs);
  });
});

describe("the live listener", () => {
  const flush = () => tick(10);
  const remoteOf = (svc: FirestoreSyncService, local: UserData) => svc.atomicSyncOrPush(DB, TEST_USER, local);

  it("attaches once a user signs in (cold start), follows sign-out and sign-in, and detaches on dispose", async () => {
    auth.user = null;
    const dispose = service.listenToRemote(vi.fn());
    expect(fake.listenerCount).toBe(0); // nobody signed in yet
    auth.setUser(TEST_USER);
    expect(fake.listenerCount).toBe(1);
    auth.setUser(null);
    expect(fake.listenerCount).toBe(0);
    auth.setUser(TEST_USER);
    expect(fake.listenerCount).toBe(1);
    auth.setUser({ ...TEST_USER, uid: "u2" }); // switching accounts moves the listener
    expect(fake.listenerCount).toBe(1);
    dispose();
    expect(fake.listenerCount).toBe(0);
    auth.setUser(TEST_USER);
    expect(fake.listenerCount).toBe(0);
  });

  it("attaches when the user opts in later, and not before", () => {
    localStorage.clear();
    const dispose = service.listenToRemote(vi.fn());
    expect(fake.listenerCount).toBe(0);
    setCloudSyncEnabled(true);
    expect(fake.listenerCount).toBe(1);
    setCloudSyncEnabled(false);
    expect(fake.listenerCount).toBe(0);
    dispose();
  });

  it("delivers another device's verified change, ignores echoes of this tab's own writes", async () => {
    const onRemote = vi.fn();
    const dispose = service.listenToRemote(onRemote);
    await remoteOf(service, library(2, 0)); // this tab publishes revision 1
    await flush();
    expect(onRemote).not.toHaveBeenCalled();

    await remoteOf(new FirestoreSyncService(), library(2, 50)); // another device publishes revision 2
    await flush();
    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(Object.keys((onRemote.mock.calls[0]![0] as UserData).library).sort()).toEqual(["al-0", "al-1", "al-50", "al-51"]);
    dispose();
    await remoteOf(new FirestoreSyncService(), library(1, 90));
    await flush();
    expect(onRemote).toHaveBeenCalledTimes(1); // disposed
  });

  it("never applies unverified remote data and reports the problem", async () => {
    await remoteOf(new FirestoreSyncService(), library(2));
    const onRemote = vi.fn();
    const dispose = service.listenToRemote(onRemote);
    await flush();
    onRemote.mockClear();
    const active = fake.docs.get(POINTER)!.data.activeSnapshotId as string;
    fake.mutate(`users/u1/snapshots/${active}`, (d) => { (d.library as Record<string, { status: string }>)["al-0"]!.status = "dropped"; });
    fake.mutate(POINTER, (d) => { d.revision = 2; });
    fake.notify(POINTER);
    await flush();
    expect(onRemote).not.toHaveBeenCalled();
    expect(service.getStatus()).toBe("error");
    expect(service.getNotice()).toMatch(/could not be read safely/);
    dispose();
  });
});

describe("persistence adapter", () => {
  const memoryAdapter = (initial: UserData | null, warning?: string) => {
    let stored = initial ? (JSON.parse(JSON.stringify(initial)) as UserData) : null;
    const saves: UserData[] = [];
    const adapter: PersistenceAdapter & { stored: () => UserData | null; saves: UserData[] } = {
      load: vi.fn(() => (stored ? (JSON.parse(JSON.stringify(stored)) as UserData) : null)),
      save: vi.fn((data: UserData) => { stored = JSON.parse(JSON.stringify(data)) as UserData; saves.push(stored); }),
      getWarning: () => warning,
      stored: () => stored,
      saves,
    };
    return adapter;
  };
  const DEBOUNCE = 20;
  // Real timers: the checksum uses the platform's async SHA-256, which fake timers cannot pump.
  const settle = async () => { await tick(DEBOUNCE * 3); for (let i = 0; i < 100 && service.isBusy(); i++) await tick(10); await tick(DEBOUNCE * 3); for (let i = 0; i < 100 && service.isBusy(); i++) await tick(10); };

  it("debounces edits into one sync and uploads the latest data", async () => {
    const local = memoryAdapter(library(1));
    const adapter = createSyncedPersistenceAdapter(local, service, DEBOUNCE);
    adapter.save(library(2));
    adapter.save(library(3));
    adapter.save(library(4));
    await settle();
    expect(fake.counters.transactions).toBe(1);
    expect(Object.keys((await loadRemoteState(DB, TEST_USER)).data!.library)).toHaveLength(4);
  });

  it("keeps edits made while a sync is running: they are merged into the result, never overwritten, and uploaded next", async () => {
    const local = memoryAdapter(library(2));
    const adapter = createSyncedPersistenceAdapter(local, service, DEBOUNCE);
    const edited = library(3);
    edited.library["al-2"] = { seriesId: "al-2", status: "dropped", addedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
    edited.savedTitles["al-2"] = library(3).savedTitles["al-2"]!;
    let edit = true;
    fake.interceptors.push((op, path) => { if (op === "txGet" && path === POINTER && edit) { edit = false; adapter.save(edited); } });
    adapter.save(library(2)); // schedules the first sync
    await settle();

    const editedAt = local.saves.findIndex((d) => "al-2" in d.library);
    expect(editedAt).toBeGreaterThanOrEqual(0); // the edit really happened during the sync
    const everySaveAfterEdit = local.saves.slice(editedAt);
    expect(everySaveAfterEdit.every((d) => d.library["al-2"]?.status === "dropped")).toBe(true);
    expect(local.stored()!.library["al-2"]?.status).toBe("dropped");
    expect((await loadRemoteState(DB, TEST_USER)).data!.library["al-2"]?.status).toBe("dropped");
  });

  it("applies remote data on first load, notifies the app, and merges instead of replacing", async () => {
    await new FirestoreSyncService().atomicSyncOrPush(DB, TEST_USER, library(2, 50));
    const local = memoryAdapter(library(1, 0));
    const adapter = createSyncedPersistenceAdapter(local, service, DEBOUNCE);
    const changed = vi.fn();
    adapter.subscribe!(changed);
    expect(adapter.load()!.library).toHaveProperty("al-0"); // the synchronous result is local data
    await settle();
    expect(Object.keys(local.stored()!.library).sort()).toEqual(["al-0", "al-50", "al-51"]);
    expect(changed).toHaveBeenCalled();
    adapter.load();
    await settle();
    expect(fake.counters.transactions).toBe(2); // one for the seed, one for the first load: later loads do not start another
  });

  it("does not sync from storage it could not read, and never uploads an empty library in its place", async () => {
    await new FirestoreSyncService().atomicSyncOrPush(DB, TEST_USER, library(3));
    const writes = fake.counters.docWrites;
    const unreadable = memoryAdapter(null, "The stored record could not be loaded");
    const adapter = createSyncedPersistenceAdapter(unreadable, service, DEBOUNCE);
    adapter.load();
    adapter.save(emptyUserData());
    await settle();
    expect(fake.counters.docWrites).toBe(writes);
    expect(fake.counters.transactions).toBe(1);
  });

  it("stays purely local when sync is not enabled", async () => {
    localStorage.clear();
    const local = memoryAdapter(library(1));
    const adapter = createSyncedPersistenceAdapter(local, service, DEBOUNCE);
    adapter.load();
    adapter.save(library(2));
    await settle();
    expect(fake.counters.docReads + fake.counters.docWrites).toBe(0);
    expect(Object.keys(local.stored()!.library)).toHaveLength(2);
  });
});

describe("secondary per-collection copies", () => {
  it("are not written by default (nothing reads them)", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(3));
    await tick(10);
    for (const collection of ["library", "progress", "readerModes", "savedTitles"]) {
      expect(fake.paths(`users/u1/${collection}/`)).toEqual([]);
    }
  });

  it("still reconcile correctly when invoked, and never overwrite a newer revision", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(2));
    const data = library(2);
    await service.reconcileSubcollections(DB, TEST_USER, 1, 1, data);
    expect(fake.paths("users/u1/library/")).toHaveLength(2);
    expect(fake.docs.get("users/u1/library/al-0")!.data).toMatchObject({ status: "reading", updatedAt: "2026-10-01T00:00:00.000Z" });
    fake.reset();
    fake.seed(POINTER, { revision: 9 });
    await service.reconcileSubcollections(DB, TEST_USER, 1, 3, data);
    expect(fake.paths("users/u1/library/")).toEqual([]);
  });
});

it("a recovery failure is a typed error, not a silent fallback to empty", async () => {
  await service.atomicSyncOrPush(DB, TEST_USER, library(1));
  fake.remove(`users/u1/snapshots/${fake.docs.get(POINTER)!.data.activeSnapshotId as string}`);
  await expect(service.fetchRemoteData(DB, TEST_USER)).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
});

describe("disabling cloud sync and switching accounts", () => {
  it("turning sync off in the middle of a run publishes nothing and removes the staged copy", async () => {
    fake.interceptors.push((op, path) => {
      if (op === "set" && path.includes("/snapshots/")) setCloudSyncEnabled(false); // user clicks Disable while the snapshot is being staged
    });
    const local = library(3);
    const outcome = await service.syncNow(() => local);
    expect(outcome).toMatchObject({ ok: false, reason: "disabled" });
    expect(service.getStatus()).toBe("disabled");
    expect(fake.docs.has(POINTER)).toBe(false);
    expect(fake.paths("users/u1/snapshots/")).toEqual([]);
    expect(outcome.data).toBe(local); // local data untouched
  });

  it("disabling stops all later cloud operations but deletes neither the cloud copy nor local data", async () => {
    await service.syncNow(() => library(2));
    const cloudBefore = canonicalStringify([...fake.docs.entries()]);
    setCloudSyncEnabled(false);
    const counters = { ...fake.counters };
    expect(await service.syncNow(() => library(5))).toMatchObject({ ok: false, reason: "disabled" });
    expect(fake.counters).toEqual(counters);
    expect(canonicalStringify([...fake.docs.entries()])).toBe(cloudBefore);
  });

  it("a switch to another account resets revision tracking so that account's changes are still delivered", async () => {
    // Account u1 is at a high revision; the Google account g1 is at revision 1.
    for (let i = 0; i < 4; i++) await service.atomicSyncOrPush(DB, TEST_USER, library(2 + i));
    const google = { uid: "g1", isAnonymous: false, metadata: { creationTime: "2025-01-01T00:00:00.000Z" } };
    await new FirestoreSyncService().atomicSyncOrPush(DB, google, library(2, 100)); // g1 revision 1
    const onRemote = vi.fn();
    const dispose = service.listenToRemote(onRemote);
    await tick(10);
    auth.setUser(google); // the user signs in to g1 on this tab
    await tick(10);
    onRemote.mockClear();
    await new FirestoreSyncService().atomicSyncOrPush(DB, google, library(1, 200)); // another device -> g1 revision 2 (< u1's 4)
    await tick(20);
    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(Object.keys((onRemote.mock.calls[0]![0] as UserData).library)).toContain("al-200");
    dispose();
  });

  it("whenIdle waits for queued syncs", async () => {
    let finished = false;
    void service.syncNow(() => library(2)).then(() => { finished = true; });
    await service.whenIdle();
    expect(finished).toBe(true);
  });
});
