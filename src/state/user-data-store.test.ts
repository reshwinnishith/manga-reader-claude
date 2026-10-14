import { describe, expect, it, vi } from "vitest";
import type { SavedTitle } from "@/domain/types";
import { getSeries } from "@/test/helpers";
import { emptyUserData } from "@/lib/user-data";
import { createLocalStorageAdapter, createMemoryAdapter, STORAGE_KEY } from "@/services/persistence";
import { createUserDataStore } from "./user-data-store";

const opts = (adapter = createLocalStorageAdapter()) => ({
  adapter,
  initial: emptyUserData,
  now: () => "2026-10-12T12:00:00.000Z",
});

const SAVED: SavedTitle = {
  id: "al-101", source: "anilist", externalId: 101, title: "Moonlit Pharmacy (Fixture)", type: "manga", description: "d",
  coverUrl: "https://example.test/c.jpg", genres: ["Mystery"], authors: ["A"], year: 2022, status: "ongoing",
  reportedChapters: 42, url: "https://anilist.co/manga/101", fetchedAt: "2026-10-14T00:00:00.000Z",
};

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

  it("migrates stored v1 data on load, preserves it, and keeps a one-time backup", () => {
    const v1 = {
      version: 1,
      seeded: true,
      library: { "neon-ronin": { seriesId: "neon-ronin", status: "reading", addedAt: "2026-01-01T00:00:00.000Z" } },
      progress: {
        "neon-ronin": {
          lastChapterId: "neon-ronin-c1",
          updatedAt: "2026-01-02T00:00:00.000Z",
          chapters: { "neon-ronin-c1": { page: 15, pageCount: 16, completed: true, updatedAt: "2026-01-02T00:00:00.000Z" } },
        },
      },
      readerModes: { "neon-ronin": "vertical" },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v1));

    const store = createUserDataStore(opts());
    const data = store.getSnapshot()!;
    expect(data.version).toBe(3);
    expect(data.savedTitles).toEqual({});
    expect(data.library["neon-ronin"]?.status).toBe("reading");
    expect(data.readerModes["neon-ronin"]).toBe("vertical");
    expect(data.progress["neon-ronin"]?.chapters["neon-ronin-c1"]).toMatchObject({ completed: true, atEnd: true });

    // Upgraded copy is persisted, original is backed up exactly once.
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).version).toBe(3);
    expect(JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}:backup-v1`)!)).toEqual(v1);
    createUserDataStore(opts()).getSnapshot(); // loading again must not overwrite the backup
    expect(JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}:backup-v1`)!)).toEqual(v1);
  });

  it("does not notify or write when the same reading position is recorded again", () => {
    const store = createUserDataStore(opts());
    store.getSnapshot();
    store.recordProgress(series, series.chapters[0]!.id, 3);
    const listener = vi.fn();
    store.subscribe(listener);
    store.recordProgress(series, series.chapters[0]!.id, 3);
    store.recordProgress(series, series.chapters[0]!.id, 3, false);
    expect(listener).not.toHaveBeenCalled();
    store.recordProgress(series, series.chapters[0]!.id, 4);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("round-trips the on-hold and dropped statuses through storage", () => {
    const a = createUserDataStore(opts());
    a.getSnapshot();
    a.addToLibrary("neon-ronin");
    a.setReadingStatus("neon-ronin", "on-hold");
    expect(createUserDataStore(opts()).getSnapshot()?.library["neon-ronin"]?.status).toBe("on-hold");
    a.setReadingStatus("neon-ronin", "dropped");
    expect(createUserDataStore(opts()).getSnapshot()?.library["neon-ronin"]?.status).toBe("dropped");
  });

  it("migrates v2 data (before title search) without losing anything and adds empty savedTitles", () => {
    const v2 = {
      version: 2, seeded: true,
      library: { "neon-ronin": { seriesId: "neon-ronin", status: "on-hold", addedAt: "2026-01-01T00:00:00.000Z" } },
      progress: { "neon-ronin": { lastChapterId: "neon-ronin-c2", updatedAt: "2026-02-01T00:00:00.000Z", chapters: {
        "neon-ronin-c2": { page: 4, pageCount: 19, atEnd: false, completed: true, updatedAt: "2026-02-01T00:00:00.000Z" } } } },
      readerModes: { "neon-ronin": "vertical" },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v2));
    const data = createUserDataStore(opts()).getSnapshot()!;
    expect(data.version).toBe(3);
    expect(data.savedTitles).toEqual({});
    expect(data.library["neon-ronin"]?.status).toBe("on-hold");
    expect(data.progress["neon-ronin"]?.chapters["neon-ronin-c2"]).toMatchObject({ page: 4, completed: true });
    expect(data.readerModes["neon-ronin"]).toBe("vertical");
    expect(JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}:backup-v2`)!)).toEqual(v2);
  });

  it("persists titles saved from search across reloads", () => {
    const a = createUserDataStore(opts());
    a.getSnapshot();
    a.saveExternalTitle(SAVED);
    const b = createUserDataStore(opts()).getSnapshot()!;
    expect(b.savedTitles["al-101"]).toEqual(SAVED);
    expect(b.library["al-101"]?.status).toBe("planned");
  });
});
