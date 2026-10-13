import { describe, expect, it, vi } from "vitest";
import { getSeries } from "@/test/helpers";
import { emptyUserData } from "@/lib/user-data";
import { createLocalStorageAdapter, createMemoryAdapter, STORAGE_KEY } from "@/services/persistence";
import { createUserDataStore } from "./user-data-store";

const opts = (adapter = createLocalStorageAdapter()) => ({
  adapter,
  initial: emptyUserData,
  now: () => "2026-10-12T12:00:00.000Z",
});

describe("user data store", () => {
  const series = getSeries("neon-ronin");

  it("persists progress to localStorage and restores it in a new store (reload)", () => {
    const a = createUserDataStore(opts());
    a.getSnapshot();
    a.recordProgress(series, series.chapters[1]!.id, 7);

    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(raw.progress["neon-ronin"].chapters[series.chapters[1]!.id].page).toBe(7);

    const b = createUserDataStore(opts());
    expect(b.getSnapshot()?.progress["neon-ronin"]?.lastChapterId).toBe(series.chapters[1]!.id);
  });

  it("notifies subscribers on change but not on no-ops", () => {
    const store = createUserDataStore(opts());
    store.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.addToLibrary("neon-ronin");
    store.addToLibrary("neon-ronin"); // duplicate: no change
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.removeFromLibrary("neon-ronin");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("seeds demo data only when nothing is stored", () => {
    const store = createUserDataStore({ adapter: createMemoryAdapter(), now: () => "x" });
    expect(Object.keys(store.getSnapshot()!.library).length).toBeGreaterThan(0);
  });

  it("recovers from corrupt stored data", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const store = createUserDataStore(opts());
    expect(store.getSnapshot()).toEqual(emptyUserData());
  });

  it("does not reseed after the user empties their library", () => {
    const a = createUserDataStore({ adapter: createLocalStorageAdapter(), now: () => "x" });
    for (const id of Object.keys(a.getSnapshot()!.library)) a.removeFromLibrary(id);
    const b = createUserDataStore({ adapter: createLocalStorageAdapter(), now: () => "x" });
    expect(Object.keys(b.getSnapshot()!.library)).toEqual([]);
  });

  it("picks up changes made in another tab", () => {
    const store = createUserDataStore(opts());
    store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    const other = { ...emptyUserData(), library: { x: { seriesId: "x", status: "reading" as const, addedAt: "t" } } };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(other));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()?.library["x"]).toBeDefined();
  });
});
