import { describe, expect, it, beforeEach, vi } from "vitest";
import type { UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";

const mockBatchCommit = vi.fn().mockResolvedValue(undefined);
const mockBatchSet = vi.fn();
const mockBatchDelete = vi.fn();

vi.mock("firebase/firestore", async (importOriginal) => {
  const orig = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...orig,
    writeBatch: vi.fn(() => ({
      set: mockBatchSet,
      delete: mockBatchDelete,
      commit: mockBatchCommit,
    })),
  };
});

import {
  mergeUserData,
  createAndVerifyLocalBackup,
  commitChunkedBatches,
  isCloudSyncEnabled,
  setCloudSyncEnabled,
  CLOUD_SYNC_OPT_IN_KEY,
  PRE_SYNC_BACKUP_KEY,
  syncService,
  type ChunkedOperation,
} from "./firestore-sync";

describe("mergeUserData", () => {
  const baseData: UserData = {
    version: USER_DATA_VERSION,
    library: {
      "series-1": {
        seriesId: "series-1",
        status: "reading",
        addedAt: "2026-10-01T10:00:00.000Z",
      },
    },
    progress: {
      "series-1": {
        lastChapterId: "ch-1",
        updatedAt: "2026-10-01T10:30:00.000Z",
        chapters: {
          "ch-1": {
            page: 5,
            pageCount: 20,
            atEnd: false,
            completed: false,
            updatedAt: "2026-10-01T10:30:00.000Z",
          },
        },
      },
    },
    readerModes: {
      "series-1": "vertical",
    },
    savedTitles: {},
    tombstones: {},
    seeded: true,
  };

  it("returns a copy of local data when remote data is empty or null", () => {
    const merged = mergeUserData(baseData, null);
    expect(merged).toEqual(baseData);
    expect(merged).not.toBe(baseData);
  });

  it("merges non-overlapping library entries", () => {
    const remote: Partial<UserData> = {
      library: {
        "series-2": {
          seriesId: "series-2",
          status: "completed",
          addedAt: "2026-10-02T12:00:00.000Z",
        },
      },
    };

    const merged = mergeUserData(baseData, remote);
    expect(merged.library["series-1"]).toBeDefined();
    expect(merged.library["series-2"]).toBeDefined();
    expect(merged.library["series-2"]?.status).toBe("completed");
  });

  it("resolves library conflict by preferring newer addedAt timestamp", () => {
    const remoteNewer: Partial<UserData> = {
      library: {
        "series-1": {
          seriesId: "series-1",
          status: "completed",
          addedAt: "2026-10-05T10:00:00.000Z",
        },
      },
    };

    const merged = mergeUserData(baseData, remoteNewer);
    expect(merged.library["series-1"]?.status).toBe("completed");

    const remoteOlder: Partial<UserData> = {
      library: {
        "series-1": {
          seriesId: "series-1",
          status: "dropped",
          addedAt: "2026-09-01T10:00:00.000Z",
        },
      },
    };

    const mergedOlder = mergeUserData(baseData, remoteOlder);
    expect(mergedOlder.library["series-1"]?.status).toBe("reading");
  });

  it("deletes a library entry when remote contains a tombstone newer than addedAt", () => {
    const remoteWithTombstone: Partial<UserData> = {
      tombstones: {
        "series-1": "2026-10-02T10:00:00.000Z", // deleted after addedAt
      },
    };

    const merged = mergeUserData(baseData, remoteWithTombstone);
    expect(merged.library["series-1"]).toBeUndefined();
    expect(merged.tombstones?.["series-1"]).toBe("2026-10-02T10:00:00.000Z");
  });

  it("deletes a library entry when local contains a tombstone newer than remote addedAt", () => {
    const localWithTombstone: UserData = {
      ...baseData,
      library: {},
      tombstones: {
        "series-2": "2026-10-05T10:00:00.000Z",
      },
    };
    const remote: Partial<UserData> = {
      library: {
        "series-2": {
          seriesId: "series-2",
          status: "reading",
          addedAt: "2026-10-03T10:00:00.000Z", // added before deletion
        },
      },
    };

    const merged = mergeUserData(localWithTombstone, remote);
    expect(merged.library["series-2"]).toBeUndefined();
    expect(merged.tombstones?.["series-2"]).toBe("2026-10-05T10:00:00.000Z");
  });

  it("preserves intentional re-addition when addedAt is newer than tombstone timestamp", () => {
    const localReAdded: UserData = {
      ...baseData,
      library: {
        "series-readded": {
          seriesId: "series-readded",
          status: "planned",
          addedAt: "2026-10-10T12:00:00.000Z", // Re-added AFTER deletion
        },
      },
      tombstones: {},
    };
    const remoteWithOlderTombstone: Partial<UserData> = {
      tombstones: {
        "series-readded": "2026-10-05T10:00:00.000Z", // Deleted earlier
      },
    };

    const merged = mergeUserData(localReAdded, remoteWithOlderTombstone);
    expect(merged.library["series-readded"]).toBeDefined();
    expect(merged.library["series-readded"]?.status).toBe("planned");
    // Tombstone is cleared because the title was intentionally re-added
    expect(merged.tombstones?.["series-readded"]).toBeUndefined();
  });

  it("unions tombstones keeping the latest deletion timestamp", () => {
    const localTombstones: UserData = {
      ...baseData,
      tombstones: {
        "series-a": "2026-10-01T00:00:00.000Z",
        "series-b": "2026-10-05T00:00:00.000Z",
      },
    };
    const remoteTombstones: Partial<UserData> = {
      tombstones: {
        "series-a": "2026-10-03T00:00:00.000Z", // Newer
        "series-c": "2026-10-04T00:00:00.000Z",
      },
    };

    const merged = mergeUserData(localTombstones, remoteTombstones);
    expect(merged.tombstones?.["series-a"]).toBe("2026-10-03T00:00:00.000Z");
    expect(merged.tombstones?.["series-b"]).toBe("2026-10-05T00:00:00.000Z");
    expect(merged.tombstones?.["series-c"]).toBe("2026-10-04T00:00:00.000Z");
  });

  it("merges progress with sticky chapter completion and highest page progress", () => {
    const remoteProgress: Partial<UserData> = {
      progress: {
        "series-1": {
          lastChapterId: "ch-1",
          updatedAt: "2026-10-03T10:00:00.000Z",
          chapters: {
            "ch-1": {
              page: 12,
              pageCount: 20,
              atEnd: false,
              completed: true,
              updatedAt: "2026-10-03T10:00:00.000Z",
            },
          },
        },
      },
    };

    const merged = mergeUserData(baseData, remoteProgress);
    const ch = merged.progress["series-1"]?.chapters["ch-1"];
    expect(ch?.page).toBe(12);
    expect(ch?.completed).toBe(true);
    expect(merged.progress["series-1"]?.updatedAt).toBe("2026-10-03T10:00:00.000Z");
  });

  it("merges saved titles favoring newer fetchedAt timestamp", () => {
    const localWithSaved: UserData = {
      ...baseData,
      savedTitles: {
        "al-100": {
          id: "al-100",
          source: "anilist",
          externalId: 100,
          title: "Initial Title",
          type: "manga",
          description: "Desc",
          genres: ["Action"],
          authors: ["Author"],
          status: "ongoing",
          url: "https://example.com",
          fetchedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };

    const remoteSaved: Partial<UserData> = {
      savedTitles: {
        "al-100": {
          id: "al-100",
          source: "anilist",
          externalId: 100,
          title: "Updated Title",
          type: "manga",
          description: "Updated Desc",
          genres: ["Action", "Adventure"],
          authors: ["Author"],
          status: "ongoing",
          url: "https://example.com",
          fetchedAt: "2026-10-05T00:00:00.000Z",
        },
        "al-200": {
          id: "al-200",
          source: "anilist",
          externalId: 200,
          title: "Second Title",
          type: "manhwa",
          description: "Second Desc",
          genres: ["Fantasy"],
          authors: ["Author 2"],
          status: "ongoing",
          url: "https://example.com/2",
          fetchedAt: "2026-10-02T00:00:00.000Z",
        },
      },
    };

    const merged = mergeUserData(localWithSaved, remoteSaved);
    expect(merged.savedTitles["al-100"]?.title).toBe("Updated Title");
    expect(merged.savedTitles["al-200"]?.title).toBe("Second Title");
  });

  it("preserves seeded flag when either local or remote is seeded", () => {
    const unseeded: UserData = { ...baseData, seeded: false };
    const remoteSeeded: Partial<UserData> = { seeded: true };

    expect(mergeUserData(unseeded, remoteSeeded).seeded).toBe(true);
    expect(mergeUserData(baseData, { seeded: false }).seeded).toBe(true);
  });
});

describe("Local backup preservation & verification", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const sampleData: UserData = {
    version: USER_DATA_VERSION,
    library: {
      "pre-sync-item": {
        seriesId: "pre-sync-item",
        status: "reading",
        addedAt: "2026-10-01T00:00:00Z",
      },
    },
    progress: {},
    readerModes: {},
    savedTitles: {},
    tombstones: {},
    seeded: true,
  };

  it("creates and verifies a recoverable pre-sync backup in localStorage", () => {
    const ok = createAndVerifyLocalBackup(sampleData);
    expect(ok).toBe(true);

    const stored = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(sampleData);
  });

  it("preserves an existing valid pre-sync backup without overwriting it", () => {
    window.localStorage.setItem(PRE_SYNC_BACKUP_KEY, JSON.stringify(sampleData));

    const alteredData: UserData = { ...sampleData, seeded: false };
    const ok = createAndVerifyLocalBackup(alteredData);
    expect(ok).toBe(true);

    const storedAfter = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    expect(JSON.parse(storedAfter!)).toEqual(sampleData);
  });

  it("detects corrupted pre-sync backup and fails verification", () => {
    window.localStorage.setItem(PRE_SYNC_BACKUP_KEY, "{corrupt-invalid-json");
    const ok = createAndVerifyLocalBackup(sampleData);
    expect(ok).toBe(false);
  });
});

describe("Cloud Sync Opt-in", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to disabled when no explicit opt-in is recorded", () => {
    expect(isCloudSyncEnabled()).toBe(false);
  });

  it("persists user opt-in when enabled", () => {
    setCloudSyncEnabled(true);
    expect(isCloudSyncEnabled()).toBe(true);
    expect(window.localStorage.getItem(CLOUD_SYNC_OPT_IN_KEY)).toBe("true");

    setCloudSyncEnabled(false);
    expect(isCloudSyncEnabled()).toBe(false);
    expect(window.localStorage.getItem(CLOUD_SYNC_OPT_IN_KEY)).toBe("false");
  });
});

describe("Chunked batch execution", () => {
  beforeEach(() => {
    mockBatchCommit.mockClear();
    mockBatchSet.mockClear();
    mockBatchDelete.mockClear();
  });

  it("executes operations in chunks under the batch limit", async () => {
    const mockDb = {} as unknown as import("firebase/firestore").Firestore;

    // We pass batchLimit = 3 to test chunking
    const operations: ChunkedOperation[] = [
      { type: "set", ref: "ref-1", data: { a: 1 } },
      { type: "set", ref: "ref-2", data: { a: 2 } },
      { type: "delete", ref: "ref-3" },
      { type: "set", ref: "ref-4", data: { a: 4 } },
      { type: "delete", ref: "ref-5" },
    ];

    await commitChunkedBatches(mockDb, operations, 3);
    // 5 operations with limit 3 should produce 2 batch commits (chunk 1: 3 ops, chunk 2: 2 ops)
    expect(mockBatchCommit).toHaveBeenCalledTimes(2);
    expect(mockBatchSet).toHaveBeenCalledTimes(3);
    expect(mockBatchDelete).toHaveBeenCalledTimes(2);
  });
});

describe("SyncStatus transitions", () => {
  it("provides status and supports status subscription", () => {
    const current = syncService.getStatus();
    expect(["idle", "synced", "offline", "syncing", "error", "disabled"]).toContain(current);

    let observed: string | undefined;
    const unsubscribe = syncService.subscribeStatus((st) => {
      observed = st;
    });

    expect(observed).toBe(current);
    unsubscribe();
  });
});
