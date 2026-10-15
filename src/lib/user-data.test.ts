import { describe, expect, it } from "vitest";
import { USER_DATA_VERSION, type SavedTitle, type UserData } from "@/domain/types";
import { getSeries } from "@/test/helpers";
import {
  addToLibrary, emptyUserData, migrateUserData, recordProgress, removeFromLibrary, saveExternalTitle, setReaderMode, setReadingStatus,
} from "./user-data";

const NOW = "2026-10-12T12:00:00.000Z";
const LATER = "2026-10-12T13:00:00.000Z";

describe("library", () => {
  it("adds as planned, ignores duplicates, and removes with tombstone", () => {
    const a = addToLibrary(emptyUserData(), "neon-ronin", NOW);
    expect(a.library["neon-ronin"]).toEqual({ seriesId: "neon-ronin", status: "planned", addedAt: NOW });
    expect(addToLibrary(a, "neon-ronin", LATER)).toBe(a);
    const removed = removeFromLibrary(a, "neon-ronin", LATER);
    expect(removed.library["neon-ronin"]).toBeUndefined();
    expect(removed.tombstones?.["neon-ronin"]).toBe(LATER);

    // Re-adding clears the tombstone
    const reAdded = addToLibrary(removed, "neon-ronin", "2026-10-12T14:00:00.000Z");
    expect(reAdded.library["neon-ronin"]).toBeDefined();
    expect(reAdded.tombstones?.["neon-ronin"]).toBeUndefined();
  });

  it("changes reading status only for series in the library", () => {
    const base = emptyUserData();
    expect(setReadingStatus(base, "x", "reading")).toBe(base);
    const a = addToLibrary(base, "neon-ronin", NOW);
    expect(setReadingStatus(a, "neon-ronin", "completed").library["neon-ronin"]?.status).toBe("completed");
  });

  it.each(["reading", "planned", "on-hold", "dropped", "completed"] as const)("supports the %s status", (status) => {
    const a = addToLibrary(emptyUserData(), "neon-ronin", NOW);
    const b = setReadingStatus(a, "neon-ronin", status);
    expect(b.library["neon-ronin"]?.status).toBe(status);
    expect(setReadingStatus(b, "neon-ronin", status)).toBe(b); // no-op when unchanged
  });

  it("remembers reader mode per series", () => {
    let d = setReaderMode(emptyUserData(), "neon-ronin", "vertical");
    d = setReaderMode(d, "last-cartographer", "paged-rtl");
    expect(d.readerModes).toEqual({ "neon-ronin": "vertical", "last-cartographer": "paged-rtl" });
  });
});

describe("recordProgress · completion boundaries", () => {
  const series = getSeries("neon-ronin");
  const c1 = series.chapters[0]!;
  const last = c1.pageCount - 1;
  const cp = (d: UserData) => d.progress[series.id]?.chapters[c1.id];

  it("stores page progress and adds the series to the library as reading", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, 3, NOW);
    expect(d.progress[series.id]?.lastChapterId).toBe(c1.id);
    expect(cp(d)).toMatchObject({ page: 3, atEnd: false, completed: false, pageCount: c1.pageCount });
    expect(d.library[series.id]?.status).toBe("reading");
  });

  it("does NOT complete a chapter by reaching its final page", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, last, NOW);
    expect(cp(d)).toMatchObject({ page: last, atEnd: false, completed: false });
  });

  it("completes only when the end of the chapter is reached", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, last, NOW, true);
    expect(cp(d)).toMatchObject({ page: last, atEnd: true, completed: true });
  });

  it("is idempotent: repeating the same position returns the same data (no duplicate completion)", () => {
    const d1 = recordProgress(emptyUserData(), series, c1.id, last, NOW, true);
    const d2 = recordProgress(d1, series, c1.id, last, LATER, true);
    expect(d2).toBe(d1);
    expect(cp(d2)?.updatedAt).toBe(NOW);
  });

  it("scrolling back off the end clears atEnd but never completed", () => {
    let d = recordProgress(emptyUserData(), series, c1.id, last, NOW, true);
    d = recordProgress(d, series, c1.id, last, LATER, false); // stepped back from the end card
    expect(cp(d)).toMatchObject({ atEnd: false, completed: true });
    d = recordProgress(d, series, c1.id, 2, LATER);
    expect(cp(d)).toMatchObject({ page: 2, atEnd: false, completed: true });
  });

  it("rereading keeps completion history", () => {
    let d = recordProgress(emptyUserData(), series, c1.id, last, NOW, true);
    d = recordProgress(d, series, c1.id, 0, LATER); // reopen from the top
    expect(cp(d)).toMatchObject({ page: 0, atEnd: false, completed: true });
  });

  it("clamps out-of-range pages and ignores unknown chapters", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, 999, NOW);
    expect(cp(d)?.page).toBe(last);
    expect(cp(d)?.completed).toBe(false);
    const empty = emptyUserData();
    expect(recordProgress(empty, series, "nope", 1, NOW)).toBe(empty);
  });

  it("only moves to the next chapter's record when reading it; earlier chapters are untouched", () => {
    let d = recordProgress(emptyUserData(), series, c1.id, last, NOW, true);
    const c2 = series.chapters[1]!;
    d = recordProgress(d, series, c2.id, 0, LATER);
    expect(d.progress[series.id]?.lastChapterId).toBe(c2.id);
    expect(d.progress[series.id]?.chapters[c1.id]).toMatchObject({ completed: true, atEnd: true });
  });
});

describe("recordProgress · library status side effects", () => {
  const series = getSeries("neon-ronin");
  const c1 = series.chapters[0]!;

  it("moves a planned series to reading but keeps its original addedAt", () => {
    let d = addToLibrary(emptyUserData(), series.id, NOW);
    d = recordProgress(d, series, c1.id, 1, LATER);
    expect(d.library[series.id]).toMatchObject({ status: "reading", addedAt: NOW });
  });

  it.each(["on-hold", "dropped"] as const)("reading moves a %s series back to reading", (status) => {
    let d = setReadingStatus(addToLibrary(emptyUserData(), series.id, NOW), series.id, status);
    d = recordProgress(d, series, c1.id, 2, LATER);
    expect(d.library[series.id]?.status).toBe("reading");
  });

  it.each(["on-hold", "dropped"] as const)("reopening at the saved position leaves a %s series alone", (status) => {
    let d = recordProgress(emptyUserData(), series, c1.id, 2, NOW);
    d = setReadingStatus(d, series.id, status);
    expect(recordProgress(d, series, c1.id, 2, LATER)).toBe(d);
    expect(d.library[series.id]?.status).toBe(status);
  });

  it("marks a finished, publication-complete series as completed", () => {
    const done = getSeries("glass-garden"); // status: completed
    let d = emptyUserData();
    for (const c of done.chapters) d = recordProgress(d, done, c.id, c.pageCount - 1, NOW, true);
    expect(d.library[done.id]?.status).toBe("completed");
  });

  it("does not complete a series just because every final page was visited", () => {
    const done = getSeries("glass-garden");
    let d = emptyUserData();
    for (const c of done.chapters) d = recordProgress(d, done, c.id, c.pageCount - 1, NOW, false);
    expect(d.library[done.id]?.status).toBe("reading");
  });

  it("does not mark an ongoing series completed when all current chapters are read", () => {
    let d = emptyUserData();
    for (const c of series.chapters) d = recordProgress(d, series, c.id, c.pageCount - 1, NOW, true);
    expect(d.library[series.id]?.status).toBe("reading");
  });

  it("rereading a completed series leaves it completed", () => {
    const done = getSeries("glass-garden");
    let d = emptyUserData();
    for (const c of done.chapters) d = recordProgress(d, done, c.id, c.pageCount - 1, NOW, true);
    d = recordProgress(d, done, done.chapters[0]!.id, 0, LATER);
    expect(d.library[done.id]?.status).toBe("completed");
  });
});

describe("migrateUserData", () => {
  const v1 = () => ({
    version: 1,
    seeded: true,
    library: {
      a: { seriesId: "a", status: "reading", addedAt: "2026-01-01T00:00:00.000Z" },
      b: { seriesId: "b", status: "completed", addedAt: "2026-01-02T00:00:00.000Z" },
      c: { seriesId: "c", status: "planned", addedAt: "2026-01-03T00:00:00.000Z" },
    },
    progress: {
      a: {
        lastChapterId: "a-c2",
        updatedAt: "2026-02-01T00:00:00.000Z",
        chapters: {
          "a-c1": { page: 11, pageCount: 12, completed: true, updatedAt: "2026-01-30T00:00:00.000Z" },
          "a-c2": { page: 4, pageCount: 12, completed: false, updatedAt: "2026-02-01T00:00:00.000Z" },
          "a-c3": { page: 3, pageCount: 12, completed: true, updatedAt: "2026-01-31T00:00:00.000Z" },
        },
      },
    },
    readerModes: { a: "vertical", b: "paged-rtl" },
  });

  it("upgrades v1 data to the current version without losing anything", () => {
    const m = migrateUserData(v1())!;
    expect(m.version).toBe(USER_DATA_VERSION);
    expect(m.seeded).toBe(true);
    expect(Object.keys(m.library)).toEqual(["a", "b", "c"]);
    expect(m.library["b"]?.status).toBe("completed");
    expect(m.library["a"]?.addedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(m.readerModes).toEqual({ a: "vertical", b: "paged-rtl" });
    expect(m.progress["a"]?.lastChapterId).toBe("a-c2");
  });

  it("keeps completion history and derives atEnd for chapters parked on their final page", () => {
    const ch = migrateUserData(v1())!.progress["a"]!.chapters;
    expect(ch["a-c1"]).toMatchObject({ completed: true, atEnd: true, page: 11 });
    expect(ch["a-c2"]).toMatchObject({ completed: false, atEnd: false, page: 4 });
    expect(ch["a-c3"]).toMatchObject({ completed: true, atEnd: false, page: 3 }); // completed earlier, reread mid-way
  });

  it("passes v2 data through unchanged and accepts the new statuses", () => {
    const d = setReadingStatus(addToLibrary(emptyUserData(), "x", NOW), "x", "on-hold");
    expect(migrateUserData(d)).toEqual(d);
    const dropped = setReadingStatus(d, "x", "dropped");
    expect(migrateUserData(dropped)?.library["x"]?.status).toBe("dropped");
  });

  it("migrates and preserves valid tombstones while ignoring invalid ones", () => {
    const raw = {
      ...v1(),
      tombstones: {
        "deleted-series": "2026-10-12T12:00:00.000Z",
        "invalid-date": "not-a-date",
        "": "2026-10-12T12:00:00.000Z",
      },
    };
    const m = migrateUserData(raw)!;
    expect(m.tombstones).toEqual({
      "deleted-series": "2026-10-12T12:00:00.000Z",
    });
  });

  it("rejects unrecognisable or future-version data", () => {
    expect(migrateUserData(null)).toBeNull();
    expect(migrateUserData("nope")).toBeNull();
    expect(migrateUserData({ version: 99, library: {}, progress: {}, readerModes: {} })).toBeNull();
    expect(migrateUserData({ version: 1 })).toBeNull();
  });
});

const TITLE: SavedTitle = {
  id: "al-101", source: "anilist", externalId: 101, title: "Moonlit Pharmacy (Fixture)", type: "manga", description: "d",
  coverUrl: "https://example.test/c.jpg", genres: ["Mystery"], authors: ["A"], year: 2022, status: "ongoing",
  reportedChapters: 42, url: "https://anilist.co/manga/101", fetchedAt: "2026-10-14T00:00:00.000Z",
};

describe("saveExternalTitle", () => {
  it("stores the snapshot and adds the title to the library as planned", () => {
    const d = saveExternalTitle(emptyUserData(), TITLE, NOW);
    expect(d.savedTitles["al-101"]).toEqual(TITLE);
    expect(d.library["al-101"]).toEqual({ seriesId: "al-101", status: "planned", addedAt: NOW });
  });

  it("leaves existing library entries, progress, demo data and other saved titles untouched", () => {
    const series = getSeries("neon-ronin");
    let d = recordProgress(emptyUserData(), series, series.chapters[0]!.id, 3, NOW);
    d = setReadingStatus(d, series.id, "on-hold");
    const other = { ...TITLE, id: "al-202", externalId: 202, title: "Other" };
    d = saveExternalTitle(d, other, NOW);
    const before = d;
    d = saveExternalTitle(d, TITLE, LATER);
    expect(d.library[series.id]).toEqual(before.library[series.id]);
    expect(d.progress).toBe(before.progress);
    expect(d.readerModes).toBe(before.readerModes);
    expect(d.savedTitles["al-202"]).toEqual(other);
  });

  it("re-saving refreshes metadata but keeps status and addedAt", () => {
    let d = saveExternalTitle(emptyUserData(), TITLE, NOW);
    d = setReadingStatus(d, "al-101", "dropped");
    d = saveExternalTitle(d, { ...TITLE, title: "Renamed" }, LATER);
    expect(d.savedTitles["al-101"]?.title).toBe("Renamed");
    expect(d.library["al-101"]).toEqual({ seriesId: "al-101", status: "dropped", addedAt: NOW });
  });

  it("keeps the metadata when the title is removed from the library (so re-adding and progress links never dangle)", () => {
    let d = saveExternalTitle(emptyUserData(), TITLE, NOW);
    d = removeFromLibrary(d, "al-101");
    expect(d.library["al-101"]).toBeUndefined();
    expect(d.savedTitles["al-101"]).toEqual(TITLE);
    expect(addToLibrary(d, "al-101", LATER).library["al-101"]?.status).toBe("planned");
  });
});

describe("migrateUserData · saved titles", () => {
  const base = () => ({ version: 3, library: {}, progress: {}, readerModes: {}, seeded: true });

  it("round-trips valid saved titles", () => {
    const d = { ...base(), savedTitles: { "al-101": TITLE } };
    expect(migrateUserData(d)?.savedTitles).toEqual({ "al-101": TITLE });
  });

  it("drops malformed snapshots and unsafe URLs but keeps good ones", () => {
    const d = {
      ...base(),
      savedTitles: {
        "al-101": TITLE,
        "al-bad1": { title: "no id fields" },
        "al-bad2": { ...TITLE, url: "javascript:alert(1)" },
        "al-bad3": { ...TITLE, source: "other" },
        "al-ok": { ...TITLE, coverUrl: "http://insecure/x.jpg", type: "nonsense", status: "weird", genres: "x" },
      },
    };
    const m = migrateUserData(d)!;
    expect(Object.keys(m.savedTitles).sort()).toEqual(["al-101", "al-ok"]);
    expect(m.savedTitles["al-ok"]).toMatchObject({ coverUrl: undefined, type: "manga", status: "ongoing", genres: [] });
  });

  it("treats a missing or invalid savedTitles field as empty", () => {
    expect(migrateUserData(base())?.savedTitles).toEqual({});
    expect(migrateUserData({ ...base(), savedTitles: [1, 2] })?.savedTitles).toEqual({});
  });
});
