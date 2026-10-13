import { describe, expect, it } from "vitest";
import { getSeries } from "@/test/helpers";
import { addToLibrary, emptyUserData, recordProgress, removeFromLibrary, setReaderMode, setReadingStatus } from "./user-data";

const NOW = "2026-10-12T12:00:00.000Z";
const LATER = "2026-10-12T13:00:00.000Z";

describe("library", () => {
  it("adds as planned, ignores duplicates, and removes", () => {
    const a = addToLibrary(emptyUserData(), "neon-ronin", NOW);
    expect(a.library["neon-ronin"]).toEqual({ seriesId: "neon-ronin", status: "planned", addedAt: NOW });
    expect(addToLibrary(a, "neon-ronin", LATER)).toBe(a);
    expect(removeFromLibrary(a, "neon-ronin").library).toEqual({});
  });

  it("changes reading status only for series in the library", () => {
    const base = emptyUserData();
    expect(setReadingStatus(base, "x", "reading")).toBe(base);
    const a = addToLibrary(base, "neon-ronin", NOW);
    expect(setReadingStatus(a, "neon-ronin", "completed").library["neon-ronin"]?.status).toBe("completed");
  });

  it("remembers reader mode per series", () => {
    let d = setReaderMode(emptyUserData(), "neon-ronin", "vertical");
    d = setReaderMode(d, "last-cartographer", "paged-rtl");
    expect(d.readerModes).toEqual({ "neon-ronin": "vertical", "last-cartographer": "paged-rtl" });
  });
});

describe("recordProgress", () => {
  const series = getSeries("neon-ronin");
  const c1 = series.chapters[0]!;

  it("stores page progress and adds the series to the library as reading", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, 3, NOW);
    expect(d.progress[series.id]?.lastChapterId).toBe(c1.id);
    expect(d.progress[series.id]?.chapters[c1.id]).toMatchObject({ page: 3, completed: false, pageCount: c1.pageCount });
    expect(d.library[series.id]?.status).toBe("reading");
  });

  it("moves a planned series to reading but keeps its original addedAt", () => {
    let d = addToLibrary(emptyUserData(), series.id, NOW);
    d = recordProgress(d, series, c1.id, 0, LATER);
    expect(d.library[series.id]).toMatchObject({ status: "reading", addedAt: NOW });
  });

  it("marks a chapter completed on its last page and keeps it completed", () => {
    let d = recordProgress(emptyUserData(), series, c1.id, c1.pageCount - 1, NOW);
    expect(d.progress[series.id]?.chapters[c1.id]?.completed).toBe(true);
    d = recordProgress(d, series, c1.id, 2, LATER); // re-reading
    expect(d.progress[series.id]?.chapters[c1.id]).toMatchObject({ page: 2, completed: true });
  });

  it("clamps out-of-range pages and ignores unknown chapters", () => {
    const d = recordProgress(emptyUserData(), series, c1.id, 999, NOW);
    expect(d.progress[series.id]?.chapters[c1.id]?.page).toBe(c1.pageCount - 1);
    const empty = emptyUserData();
    expect(recordProgress(empty, series, "nope", 1, NOW)).toBe(empty);
  });

  it("marks a finished, publication-complete series as completed", () => {
    const done = getSeries("glass-garden"); // status: completed
    let d = emptyUserData();
    for (const c of done.chapters) d = recordProgress(d, done, c.id, c.pageCount - 1, NOW);
    expect(d.library[done.id]?.status).toBe("completed");
  });

  it("does not mark an ongoing series completed when all current chapters are read", () => {
    let d = emptyUserData();
    for (const c of series.chapters) d = recordProgress(d, series, c.id, c.pageCount - 1, NOW);
    expect(d.library[series.id]?.status).toBe("reading");
  });
});
