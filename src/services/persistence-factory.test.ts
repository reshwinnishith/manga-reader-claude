import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserData } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import type { PersistenceAdapter } from "./persistence";

const state = vi.hoisted(() => ({
  configured: true,
  moduleEvaluations: 0,
  synced: null as null | { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> },
  created: [] as PersistenceAdapter[],
}));

vi.mock("./firebase-config", () => ({ isFirebaseConfigured: () => state.configured, getFirebaseConfigFromEnv: () => null }));
// If this factory runs, the (heavy) sync module has been imported.
vi.mock("./firestore-sync", () => {
  state.moduleEvaluations++;
  return {
    createSyncedPersistenceAdapter: (base: PersistenceAdapter) => {
      state.created.push(base);
      state.synced = { load: vi.fn(() => base.load()), save: vi.fn((d: UserData) => base.save(d)), subscribe: vi.fn(() => vi.fn()) };
      return state.synced;
    },
  };
});

let createAppPersistenceAdapter: typeof import("./persistence-factory").createAppPersistenceAdapter;
let setCloudSyncEnabled: typeof import("./cloud-sync-preference").setCloudSyncEnabled;

const localAdapter = () => {
  const adapter: PersistenceAdapter = {
    load: vi.fn(() => emptyUserData()),
    save: vi.fn(),
    getWarning: () => undefined,
    subscribe: vi.fn(() => vi.fn()),
  };
  return adapter;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  state.configured = true;
  state.synced = null;
  state.created.length = 0;
  state.moduleEvaluations = 0;
  vi.resetModules(); // each test starts with the sync module not yet loaded
  ({ createAppPersistenceAdapter } = await import("./persistence-factory"));
  ({ setCloudSyncEnabled } = await import("./cloud-sync-preference")); // same module instance the factory uses
});

describe("lazy cloud-sync loading", () => {
  it("returns the plain local adapter, and never loads the sync module, when Firebase is not configured", async () => {
    state.configured = false;
    setCloudSyncEnabled(true); // even if a stale opt-in exists
    const local = localAdapter();
    const adapter = createAppPersistenceAdapter(local);
    expect(adapter).toBe(local);
    adapter.load();
    adapter.save(emptyUserData());
    await flush();
    expect(state.moduleEvaluations).toBe(0);
  });

  it("does not load the sync module while the user has not opted in", async () => {
    const local = localAdapter();
    const adapter = createAppPersistenceAdapter(local);
    adapter.load();
    adapter.save(emptyUserData());
    adapter.subscribe!(vi.fn());
    await flush();
    expect(state.moduleEvaluations).toBe(0);
    expect(local.save).toHaveBeenCalledTimes(1);
  });

  it("loads the module once after opt-in, starts the first sync, then routes saves through it", async () => {
    setCloudSyncEnabled(true);
    const local = localAdapter();
    const adapter = createAppPersistenceAdapter(local);
    adapter.load();
    adapter.load(); // repeated loads must not create a second synced adapter
    adapter.save(emptyUserData()); // before the module arrives: saved locally, never lost
    expect(local.save).toHaveBeenCalledTimes(1);
    await flush();
    expect(state.created).toHaveLength(1);
    expect(state.synced!.load).toHaveBeenCalledTimes(1);
    adapter.save(emptyUserData());
    expect(state.synced!.save).toHaveBeenCalledTimes(1);
    expect(local.save).toHaveBeenCalledTimes(2); // the synced adapter writes through to local
  });

  it("the synced adapter does not re-subscribe to local changes (no duplicate notifications)", async () => {
    setCloudSyncEnabled(true);
    const local = localAdapter();
    const adapter = createAppPersistenceAdapter(local);
    const onChange = vi.fn();
    adapter.subscribe!(onChange);
    adapter.load();
    await flush();
    expect(local.subscribe).toHaveBeenCalledTimes(1);
    expect(state.created[0]!.subscribe).toBeUndefined();
    expect(state.synced!.subscribe).toHaveBeenCalledWith(onChange); // remote changes still reach the app
  });

  it("starts syncing when the user opts in later, without a reload", async () => {
    const local = localAdapter();
    const adapter = createAppPersistenceAdapter(local);
    const unsubscribe = adapter.subscribe!(vi.fn());
    adapter.load();
    await flush();
    expect(state.moduleEvaluations).toBe(0);
    setCloudSyncEnabled(true);
    await flush();
    expect(state.created).toHaveLength(1);
    expect(state.synced!.load).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("falls back to local storage if the sync module fails to load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setCloudSyncEnabled(true);
    vi.doMock("./firestore-sync", () => { throw new Error("chunk failed to load"); });
    vi.resetModules();
    const { createAppPersistenceAdapter: fresh } = await import("./persistence-factory");
    const local = localAdapter();
    const adapter = fresh(local);
    adapter.load();
    await flush();
    adapter.save(emptyUserData());
    expect(local.save).toHaveBeenCalledTimes(1);
    vi.doUnmock("./firestore-sync");
  });
});
