import { describe, expect, it, beforeEach } from "vitest";
import {
  mergeUserData,
  PRE_SYNC_BACKUP_KEY,
  syncService,
} from "./firestore-sync";
import type { UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";

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

describe("Local backup preservation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores a pre-sync backup in localStorage only once", () => {
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
      seeded: true,
    };

    syncService.preserveLocalBackup(sampleData);
    const stored = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(sampleData);

    // Second call should not overwrite the pre-sync backup
    const alteredData: UserData = { ...sampleData, seeded: false };
    syncService.preserveLocalBackup(alteredData);
    const storedAfter = window.localStorage.getItem(PRE_SYNC_BACKUP_KEY);
    expect(JSON.parse(storedAfter!)).toEqual(sampleData);
  });
});

describe("SyncStatus transitions", () => {
  it("provides initial status and supports status subscription", () => {
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
