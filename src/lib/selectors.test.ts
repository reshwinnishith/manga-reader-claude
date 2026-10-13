import { describe, expect, it } from "vitest";
import { MOCK_SERIES } from "@/data/mock-catalog";
import { createDemoUserData } from "@/data/demo-user-data";
import { getSeries } from "@/test/helpers";
import {
  filterLibrary, getChapterStartPage, getChapterState, getContinueReading, getNewChapters,
  getResumeTarget, getSeriesProgressFraction, searchCatalog,
} from "./selectors";
import { addToLibrary, emptyUserData, recordProgress } from "./user-data";

const NOW = "2026-10-12T12:00:00.000Z";
const series = getSeries("skyward-lanterns");

describe("getResumeTarget", () => {
  it("starts at chapter 1 when nothing has been read", () => {
    const t = getResumeTarget(series, undefined)!;
    expect(t).toMatchObject({ kind: "start", page: 0 });
    expect(t.chapter.id).toBe(series.chapters[0]!.id);
  });

  it("resumes mid-chapter on the saved page", () => {
    const d = recordProgress(emptyUserData(), series, series.chapters[2]!.id, 5, NOW);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t).toMatchObject({ kind: "continue", page: 5 });
    expect(t.chapter.id).toBe(series.chapters[2]!.id);
  });

  it("moves to the next chapter after finishing one", () => {
    const c = series.chapters[0]!;
    const d = recordProgress(emptyUserData(), series, c.id, c.pageCount - 1, NOW);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t.chapter.id).toBe(series.chapters[1]!.id);
    expect(t.page).toBe(0);
  });

  it("offers to re-read once the final chapter is finished", () => {
    const last = series.chapters.at(-1)!;
    const d = recordProgress(emptyUserData(), series, last.id, last.pageCount - 1, NOW);
    expect(getResumeTarget(series, d.progress[series.id])).toMatchObject({ kind: "reread", page: 0 });
  });
});

describe("chapter helpers", () => {
  it("opens finished chapters from the top and in-progress ones where you left off", () => {
    const [c1, c2] = series.chapters as [typeof series.chapters[0], typeof series.chapters[0]];
    let d = recordProgress(emptyUserData(), series, c1.id, c1.pageCount - 1, NOW);
    d = recordProgress(d, series, c2.id, 4, NOW);
    const p = d.progress[series.id];
    expect(getChapterStartPage(c1, p)).toBe(0);
    expect(getChapterStartPage(c2, p)).toBe(4);
    expect(getChapterState(c1, p)).toBe("read");
    expect(getChapterState(c2, p)).toBe("in-progress");
    expect(getChapterState(series.chapters[3]!, p)).toBe("unread");
  });

  it("computes series progress as a fraction", () => {
    expect(getSeriesProgressFraction(series, undefined)).toBe(0);
    let d = emptyUserData();
    for (const c of series.chapters.slice(0, 6)) d = recordProgress(d, series, c.id, c.pageCount - 1, NOW);
    expect(getSeriesProgressFraction(series, d.progress[series.id])).toBeCloseTo(0.5, 5);
  });
});

describe("home selectors", () => {
  const demo = createDemoUserData();

  it("orders Continue Reading by most recent activity and hides finished series", () => {
    const items = getContinueReading(MOCK_SERIES, demo).map((i) => i.series.id);
    expect(items[0]).toBe("tower-of-quiet-clocks");
    expect(items).not.toContain("rooftop-rivals");
  });

  it("lists recent, unread chapters only for library series", () => {
    const ids = getNewChapters(MOCK_SERIES, demo).map((i) => i.series.id);
    expect(ids).toContain("tower-of-quiet-clocks");
    expect(ids).not.toContain("neon-ronin"); // not in library
    expect(ids).not.toContain("rooftop-rivals"); // old release dates
  });

  it("drops a series from New Chapters once its recent chapters are read", () => {
    const tower = getSeries("tower-of-quiet-clocks");
    let d = demo;
    for (const c of tower.chapters) d = recordProgress(d, tower, c.id, c.pageCount - 1, NOW);
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).not.toContain(tower.id);
  });
});

describe("library & discover filtering", () => {
  const demo = createDemoUserData();

  it("filters the library by status and query", () => {
    expect(filterLibrary(MOCK_SERIES, demo, "completed", "").map((s) => s.id)).toEqual(["rooftop-rivals"]);
    expect(filterLibrary(MOCK_SERIES, demo, "all", "tower").map((s) => s.id)).toEqual(["tower-of-quiet-clocks"]);
    expect(filterLibrary(MOCK_SERIES, demo, "all", "zzz")).toEqual([]);
  });

  it("only includes series that are in the library", () => {
    const d = addToLibrary(emptyUserData(), "neon-ronin", NOW);
    expect(filterLibrary(MOCK_SERIES, d, "all", "").map((s) => s.id)).toEqual(["neon-ronin"]);
  });

  it("searches the catalog by title, author or genre, with a type filter", () => {
    expect(searchCatalog(MOCK_SERIES, "neon", "all").map((s) => s.id)).toEqual(["neon-ronin"]);
    expect(searchCatalog(MOCK_SERIES, "seo ji-woo", "all").map((s) => s.id)).toEqual(["last-cartographer"]);
    expect(searchCatalog(MOCK_SERIES, "", "manhwa").every((s) => s.type === "manhwa")).toBe(true);
    expect(searchCatalog(MOCK_SERIES, "mystery", "manga").map((s) => s.id)).toEqual(["moonlit-pharmacy"]);
  });
});
