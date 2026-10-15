import { describe, expect, it, beforeEach, vi } from "vitest";
import type { UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";

const inMemoryStore = new Map<string, unknown>();
const mockBatchCommit = vi.fn().mockResolvedValue(undefined);
const mockBatchSet = vi.fn();
const mockBatchDelete = vi.fn();
const mockGetDoc = vi.fn();
const mockSetDoc = vi.fn().mockResolvedValue(undefined);
const mockRunTransaction = vi.fn();

vi.mock("firebase/firestore", async (importOriginal) => {
  const orig = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...orig,
    collection: vi.fn((_db: unknown, ...segments: string[]) => ({
      path: segments.join("/"),
      id: segments[segments.length - 1],
    })),
    getDocs: vi.fn().mockImplementation(async (colRef: { path: string }) => {
      const docs: Array<{ id: string; ref: { path: string }; data: () => unknown }> = [];
      for (const [docPath, data] of inMemoryStore.entries()) {
        if (
          docPath.startsWith(colRef.path + "/") &&
          !docPath.slice(colRef.path.length + 1).includes("/")
        ) {
          const id = docPath.split("/").pop()!;
          docs.push({ id, ref: { path: docPath }, data: () => data });
        }
      }
      return {
        empty: docs.length === 0,
        forEach: (cb: (doc: unknown) => void) => docs.forEach(cb),
        docs,
      };
    }),
    doc: vi.fn((_db: unknown, ...segments: string[]) => ({
      path: segments.join("/"),
      id: segments[segments.length - 1],
    })),
    setDoc: vi.fn(async (ref: { path: string }, data: unknown) => {
      inMemoryStore.set(ref.path, data);
      return mockSetDoc(ref, data);
    }),
    getDoc: vi.fn(async (ref: { path: string }, ...args: unknown[]) => {
      if (ref.path.includes("/snapshots/") && inMemoryStore.has(ref.path)) {
        const data = inMemoryStore.get(ref.path);
        return {
          exists: () => true,
          data: () => data,
          id: ref.path.split("/").pop()!,
          ref,
        };
      }
      if (mockGetDoc.getMockImplementation()) {
        const custom = await mockGetDoc(ref, ...args);
        if (custom !== undefined) return custom;
      }
      if (inMemoryStore.has(ref.path)) {
        const data = inMemoryStore.get(ref.path);
        return {
          exists: () => true,
          data: () => data,
          id: ref.path.split("/").pop()!,
          ref,
        };
      }
      return {
        exists: () => false,
        data: () => undefined,
        id: ref.path.split("/").pop()!,
        ref,
      };
    }),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
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
  estimateDataSize,
  FIRESTORE_DOC_MAX_BYTES,
  FIRESTORE_DOC_SAFE_LIMIT_BYTES,
  FIRESTORE_RECORD_SAFE_LIMIT_BYTES,
  validateRecordSizeGuards,
  computeDataChecksum,
  generateSnapshotId,
  stageAndVerifySnapshot,
  pruneObsoleteSnapshots,
  CLOUD_SYNC_OPT_IN_KEY,
  PRE_SYNC_BACKUP_KEY,
  syncService,
  type ChunkedOperation,
  type StagedSnapshotDoc,
  type StagedSnapshotPartDoc,
} from "./firestore-sync";

beforeEach(() => {
  inMemoryStore.clear();
  mockBatchCommit.mockClear();
  mockBatchSet.mockClear();
  mockBatchDelete.mockClear();
  mockGetDoc.mockReset();
  mockSetDoc.mockClear();
  mockRunTransaction.mockReset();
});

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

describe("1 MiB Document Size Guard & Safe Fallback", () => {
  it("accurately estimates serialized JSON byte sizes", () => {
    const smallObject = { key: "value" };
    const size = estimateDataSize(smallObject);
    expect(size).toBe(new TextEncoder().encode(JSON.stringify(smallObject)).length);
    expect(size).toBeGreaterThan(0);
  });

  it("enforces safe limit threshold below Firestore 1 MiB hard limit", () => {
    expect(FIRESTORE_DOC_SAFE_LIMIT_BYTES).toBeLessThan(FIRESTORE_DOC_MAX_BYTES);
    expect(FIRESTORE_DOC_SAFE_LIMIT_BYTES).toBe(900 * 1024);
    expect(FIRESTORE_DOC_MAX_BYTES).toBe(1048576);
  });

  it("identifies oversized datasets exceeding safe threshold", () => {
    const largeLibrary: Record<string, unknown> = {};
    for (let i = 0; i < 6000; i++) {
      largeLibrary[`series-${i}`] = {
        seriesId: `series-${i}`,
        status: "reading",
        title: `Manga Title Number ${i} With Long Detailed Metadata Description String`,
        addedAt: "2026-10-01T00:00:00.000Z",
      };
    }
    const byteSize = estimateDataSize({ library: largeLibrary });
    expect(byteSize).toBeGreaterThan(FIRESTORE_DOC_SAFE_LIMIT_BYTES);
  });
});

describe("Delayed reconciliation protection", () => {
  it("aborts reconciliation when server is already at a newer revision", async () => {
    const mockDb = {} as unknown as import("firebase/firestore").Firestore;
    const mockUser = { uid: "test-user" } as unknown as import("firebase/auth").User;

    const sampleUserData: UserData = {
      version: USER_DATA_VERSION,
      library: {
        "series-a": { seriesId: "series-a", status: "reading", addedAt: "2026-10-01" },
      },
      progress: {},
      readerModes: {},
      savedTitles: {},
      seeded: true,
    };

    // Calling reconcile with targetRevision 4 when server is at 5 should safely abort
    // without invoking subcollection batch writes
    mockBatchCommit.mockClear();

    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ revision: 5 }),
    });

    await syncService.reconcileSubcollections(
      mockDb,
      mockUser,
      0, // reconciliationId
      4, // targetRevision (older than server revision 5)
      sampleUserData
    );

    // Because targetRevision (4) < server revision (5), no batch commits should occur
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });
});

describe("Concurrency & Interrupted Write Resilience", () => {
  const sampleLocal: UserData = {
    version: USER_DATA_VERSION,
    library: {
      "local-series": {
        seriesId: "local-series",
        status: "reading",
        addedAt: "2026-10-10T00:00:00.000Z",
      },
    },
    progress: {},
    readerModes: {},
    savedTitles: {},
    seeded: true,
  };


  it("preserves authoritative consistency even if subcollection reconciliation fails", async () => {
    const mockDb = {} as unknown as import("firebase/firestore").Firestore;
    const mockUser = {
      uid: "interrupted-user",
      isAnonymous: true,
      metadata: {},
    } as unknown as import("firebase/auth").User;

    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        version: USER_DATA_VERSION,
        revision: 1,
        library: {},
        progress: {},
        readerModes: {},
        savedTitles: {},
      }),
    });

    mockRunTransaction.mockImplementation(
      async (
        _db: unknown,
        updateFunction: (tx: {
          get: (ref: unknown) => Promise<{ exists: () => boolean; data: () => { revision: number } }>;
          set: (ref: unknown, data: unknown, options?: unknown) => void;
        }) => Promise<number>
      ) => {
        const fakeTx = {
          get: vi.fn().mockResolvedValue({
            exists: () => true,
            data: () => ({ revision: 1 }),
          }),
          set: vi.fn(),
        };
        return updateFunction(fakeTx);
      }
    );

    // Make batch commit reject to simulate interrupted subcollection write
    mockBatchCommit.mockRejectedValueOnce(
      new Error("Network connection lost during subcollection reconciliation")
    );

    // The atomicSyncOrPush itself MUST succeed because authoritative state committed FIRST
    const result = await syncService.atomicSyncOrPush(mockDb, mockUser, sampleLocal);
    expect(result.library["local-series"]).toBeDefined();
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

describe("Staged Immutable Snapshot Architecture", () => {
  const mockDb = {} as unknown as import("firebase/firestore").Firestore;
  const mockUser = {
    uid: "snapshot-test-user",
    isAnonymous: true,
    metadata: { creationTime: "2026-10-01T00:00:00.000Z" },
  } as unknown as import("firebase/auth").User;

  const sampleValidData: UserData = {
    version: USER_DATA_VERSION,
    library: {
      "series-1": {
        seriesId: "series-1",
        status: "reading",
        addedAt: "2026-10-01T00:00:00.000Z",
      },
    },
    progress: {
      "series-1": {
        lastChapterId: "ch-1",
        updatedAt: "2026-10-01T00:00:00.000Z",
        chapters: {
          "ch-1": {
            page: 5,
            pageCount: 20,
            atEnd: false,
            completed: false,
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        },
      },
    },
    readerModes: { "series-1": "vertical" },
    savedTitles: {
      "series-1": {
        id: "series-1",
        title: "Test Manga",
        source: "anilist",
        externalId: 1,
        type: "manga",
        description: "Desc",
        genres: ["Action"],
        authors: ["Author"],
        status: "ongoing",
        url: "https://example.com",
        fetchedAt: "2026-10-01T00:00:00.000Z",
      },
    },
    tombstones: {},
    seeded: true,
  };

  describe("Record and Manifest Size Guards", () => {
    it("passes for normal sized user data", () => {
      expect(() => validateRecordSizeGuards(sampleValidData)).not.toThrow();
    });

    it("rejects oversized single library records (> 500 KiB)", () => {
      const oversizedLibraryData: UserData = {
        ...sampleValidData,
        library: {
          "huge-series": {
            seriesId: "huge-series",
            status: "reading",
            addedAt: "2026-10-01T00:00:00.000Z",
            title: "x".repeat(FIRESTORE_RECORD_SAFE_LIMIT_BYTES + 100),
          } as unknown as import("@/domain/types").LibraryEntry,
        },
      };

      expect(() => validateRecordSizeGuards(oversizedLibraryData)).toThrow(
        /Library record 'huge-series' exceeds safe record size limit/
      );
    });

    it("rejects oversized single progress records (> 500 KiB)", () => {
      const oversizedProgressData: UserData = {
        ...sampleValidData,
        progress: {
          "huge-prog": {
            lastChapterId: "x".repeat(FIRESTORE_RECORD_SAFE_LIMIT_BYTES + 100),
            updatedAt: "2026-10-01T00:00:00.000Z",
            chapters: {},
          },
        },
      };

      expect(() => validateRecordSizeGuards(oversizedProgressData)).toThrow(
        /Progress record 'huge-prog' exceeds safe record size limit/
      );
    });

    it("rejects oversized single saved title records (> 500 KiB)", () => {
      const oversizedSavedData: UserData = {
        ...sampleValidData,
        savedTitles: {
          "huge-title": {
            id: "huge-title",
            title: "huge",
            description: "x".repeat(FIRESTORE_RECORD_SAFE_LIMIT_BYTES + 100),
            source: "anilist",
            externalId: 1,
            type: "manga",
            genres: [],
            authors: [],
            status: "ongoing",
            url: "https://example.com",
            fetchedAt: "2026-10-01T00:00:00.000Z",
          },
        },
      };

      expect(() => validateRecordSizeGuards(oversizedSavedData)).toThrow(
        /Saved title record 'huge-title' exceeds safe record size limit/
      );
    });

    it("rejects oversized manifest metadata (> 900 KiB)", () => {
      const hugeTombstones: Record<string, string> = {};
      for (let i = 0; i < 25000; i++) {
        hugeTombstones[`deleted-series-${i}`] = "2026-10-01T00:00:00.000Z";
      }

      const oversizedManifestData: UserData = {
        ...sampleValidData,
        tombstones: hugeTombstones,
      };

      expect(() => validateRecordSizeGuards(oversizedManifestData)).toThrow(
        /Manifest metadata exceeds Firestore safe document size limit/
      );
    });
  });

  describe("Deterministic Checksum & Snapshot ID", () => {
    it("computes identical checksums for identical data structures", async () => {
      const cs1 = await computeDataChecksum(sampleValidData);
      const cs2 = await computeDataChecksum({ ...sampleValidData });
      expect(cs1).toBe(cs2);
      expect(typeof cs1).toBe("string");
      expect(cs1.length).toBeGreaterThan(0);
    });

    it("computes different checksums when data is modified", async () => {
      const cs1 = await computeDataChecksum(sampleValidData);
      const modified: UserData = {
        ...sampleValidData,
        library: {
          ...sampleValidData.library,
          "series-2": {
            seriesId: "series-2",
            status: "completed",
            addedAt: "2026-10-02T00:00:00.000Z",
          },
        },
      };
      const cs2 = await computeDataChecksum(modified);
      expect(cs1).not.toBe(cs2);
    });

    it("generates collision-free snapshot IDs scoped by revision and session", () => {
      const id1 = generateSnapshotId(5, "session-abc");
      const id2 = generateSnapshotId(5, "session-abc");
      expect(id1).toMatch(/^rev_5_session-abc_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^rev_5_session-abc_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe("string");
    });
  });

  describe("Staged Immutable Snapshot Staging & Verification", () => {
    it("stages and verifies a single snapshot document for datasets under 900 KiB", async () => {
      const result = await stageAndVerifySnapshot(mockDb, mockUser, 1, sampleValidData);

      expect(result.snapshotId).toContain("rev_1_");
      expect(result.totalParts).toBe(1);
      expect(typeof result.checksum).toBe("string");

      // Verify read-back document in memory store
      const path = `users/${mockUser.uid}/snapshots/${result.snapshotId}`;
      const savedDoc = inMemoryStore.get(path) as StagedSnapshotDoc;
      expect(savedDoc).toBeDefined();
      expect(savedDoc.isComplete).toBe(true);
      expect(savedDoc.revision).toBe(1);
      expect(savedDoc.checksum).toBe(result.checksum);
      expect(savedDoc.library?.["series-1"]).toBeDefined();
    });

  });

  describe("Large Library Multi-Part Partitioning & Reconstruction", () => {
    it("partitions oversized datasets (> 900 KiB) into parts <= 900 KiB and marks parent complete", async () => {
      // Build dataset > 900 KiB
      const largeLibrary: Record<string, import("@/domain/types").LibraryEntry> = {};
      const numEntries = 1200;
      for (let i = 0; i < numEntries; i++) {
        largeLibrary[`series-${i}`] = {
          seriesId: `series-${i}`,
          status: "reading",
          addedAt: "2026-10-01T00:00:00.000Z",
          title: `Manga Title Number ${i} With Padded String To Ensure Size Exceeds Safe Threshold ${i}`.repeat(
            8
          ),
        } as unknown as import("@/domain/types").LibraryEntry;
      }

      const largeData: UserData = {
        ...sampleValidData,
        library: largeLibrary,
      };

      expect(estimateDataSize(largeData)).toBeGreaterThan(FIRESTORE_DOC_SAFE_LIMIT_BYTES);

      const result = await stageAndVerifySnapshot(mockDb, mockUser, 3, largeData);
      expect(result.totalParts).toBeGreaterThan(1);

      // Verify parent doc is marked complete
      const parentPath = `users/${mockUser.uid}/snapshots/${result.snapshotId}`;
      const parentDoc = inMemoryStore.get(parentPath) as StagedSnapshotDoc;
      expect(parentDoc.isComplete).toBe(true);
      expect(parentDoc.totalParts).toBe(result.totalParts);

      // Verify each part was stored and verified
      for (let p = 0; p < result.totalParts; p++) {
        const partPath = `users/${mockUser.uid}/snapshots/${result.snapshotId}/parts/part_${p}`;
        const partDoc = inMemoryStore.get(partPath) as StagedSnapshotPartDoc;
        expect(partDoc).toBeDefined();
        expect(partDoc.partIndex).toBe(p);
        expect(partDoc.totalParts).toBe(result.totalParts);
      }

      // Verify remote reader reconstructs the multi-part snapshot seamlessly
      inMemoryStore.set(`users/${mockUser.uid}/sync/userData`, {
        revision: 3,
        activeSnapshotId: result.snapshotId,
        snapshotParts: result.totalParts,
        snapshotChecksum: result.checksum,
        version: USER_DATA_VERSION,
        updatedAt: new Date().toISOString(),
      });

      const fetched = await syncService.fetchRemoteData(mockDb, mockUser);
      expect(fetched.data).not.toBeNull();
      expect(fetched.revision).toBe(3);
      expect(Object.keys(fetched.data!.library).length).toBe(numEntries);
    });

  });

  describe("Snapshot Retention & Safe Fallback Pruning", () => {

    it("never deletes the active snapshot even if its revision is old", async () => {
      const oldActiveSnapId = "rev_1_still_active";
      inMemoryStore.set(`users/${mockUser.uid}/snapshots/${oldActiveSnapId}`, {
        snapshotId: oldActiveSnapId,
        revision: 1,
        isComplete: true,
        version: USER_DATA_VERSION,
      });

      await pruneObsoleteSnapshots(mockDb, mockUser, 10, oldActiveSnapId);

      // mockBatchDelete should NOT have been called for oldActiveSnapId
      const deletedPaths = mockBatchDelete.mock.calls.map((call) => call[0]?.ref?.path || call[0]?.path);
      expect(deletedPaths).not.toContain(`users/${mockUser.uid}/snapshots/${oldActiveSnapId}`);
    });
  });
});

