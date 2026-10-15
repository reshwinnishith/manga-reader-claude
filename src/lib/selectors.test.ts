import { describe, expect, it } from "vitest";
import type { Series } from "@/domain/types";
import { MOCK_SERIES } from "@/data/mock-catalog";
import { createDemoUserData } from "@/data/demo-user-data";
import { getSeries } from "@/test/helpers";
import {
  filterLibrary, getChapterStartPage, getChapterState, getContinueReading, getNewChapters,
  getResumeTarget, getSeriesProgressFraction, searchCatalog,
} from "./selectors";
import { addToLibrary, emptyUserData, recordProgress, setReadingStatus } from "./user-data";

const NOW = "2026-10-12T12:00:00.000Z";
const series = getSeries("skyward-lanterns");
const ch = (n: number) => series.chapters[n - 1]!;
const read = (d = emptyUserData(), n: number, page: number, atEnd = false) =>
  recordProgress(d, series, ch(n).id, page, NOW, atEnd);

describe("getResumeTarget", () => {
  it("starts at chapter 1 when nothing has been read", () => {
    const t = getResumeTarget(series, undefined)!;
    expect(t).toMatchObject({ kind: "start", page: 0 });
    expect(t.chapter.id).toBe(ch(1).id);
  });

  it("resumes mid-chapter on the saved page", () => {
    const d = read(undefined, 3, 5);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t).toMatchObject({ kind: "continue", page: 5 });
    expect(t.chapter.id).toBe(ch(3).id);
  });

  it("stays on a chapter's final page: being there does not finish it", () => {
    const d = read(undefined, 1, ch(1).pageCount - 1);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t.chapter.id).toBe(ch(1).id);
    expect(t.page).toBe(ch(1).pageCount - 1);
    expect(t.kind).toBe("continue");
  });

  it("moves to the next chapter from the top once the end of a chapter was reached", () => {
    const d = read(undefined, 1, ch(1).pageCount - 1, true);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t.chapter.id).toBe(ch(2).id);
    expect(t.page).toBe(0);
  });

  it("lands on partial progress in the next chapter if there is some", () => {
    let d = read(undefined, 2, 6);
    d = read(d, 1, ch(1).pageCount - 1, true); // finishing 1 (last read) points at 2
    expect(getResumeTarget(series, d.progress[series.id])).toMatchObject({ page: 6 });
    expect(getResumeTarget(series, d.progress[series.id])!.chapter.id).toBe(ch(2).id);
  });

  it("returns to the previous place after stepping back from the end", () => {
    let d = read(undefined, 1, ch(1).pageCount - 1, true);
    d = read(d, 1, ch(1).pageCount - 1, false);
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t.chapter.id).toBe(ch(1).id);
    expect(t.kind).toBe("continue");
  });

  it("offers 'reread' (caught up) at the end of the final chapter", () => {
    const last = series.chapters.at(-1)!;
    const d = recordProgress(emptyUserData(), series, last.id, last.pageCount - 1, NOW, true);
    expect(getResumeTarget(series, d.progress[series.id])).toMatchObject({ kind: "reread", page: 0 });
  });

  it("resumes a chapter being reread, not the next one, even though it was completed before", () => {
    let d = read(undefined, 1, ch(1).pageCount - 1, true);
    d = read(d, 1, 3); // reopened and scrolled back to page 4
    const t = getResumeTarget(series, d.progress[series.id])!;
    expect(t.chapter.id).toBe(ch(1).id);
    expect(t.page).toBe(3);
  });
});

describe("chapter helpers", () => {
  it("opens chapters left at their end from the top and others where you left off", () => {
    let d = read(undefined, 1, ch(1).pageCount - 1, true);
    d = read(d, 2, 4);
    const p = d.progress[series.id];
    expect(getChapterStartPage(ch(1), p)).toBe(0);
    expect(getChapterStartPage(ch(2), p)).toBe(4);
    expect(getChapterStartPage(ch(4), p)).toBe(0);
  });

  it("opens a chapter whose final page was visited (but not finished) on that page", () => {
    const d = read(undefined, 1, ch(1).pageCount - 1);
    expect(getChapterStartPage(ch(1), d.progress[series.id])).toBe(ch(1).pageCount - 1);
  });

  it("reports chapter state; completion survives rereading", () => {
    let d = read(undefined, 1, ch(1).pageCount - 1, true);
    d = read(d, 2, 4);
    const p = () => d.progress[series.id];
    expect(getChapterState(ch(1), p())).toBe("read");
    expect(getChapterState(ch(2), p())).toBe("in-progress");
    expect(getChapterState(ch(4), p())).toBe("unread");
    d = read(d, 1, 2); // rereading chapter 1
    expect(getChapterState(ch(1), p())).toBe("read");
  });

  it("computes series progress as a fraction", () => {
    expect(getSeriesProgressFraction(series, undefined)).toBe(0);
    let d = emptyUserData();
    for (const c of series.chapters.slice(0, 6)) d = recordProgress(d, series, c.id, c.pageCount - 1, NOW, true);
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

  it("keeps on-hold and dropped series off Home (Continue Reading and New Chapters)", () => {
    const items = getContinueReading(MOCK_SERIES, demo).map((i) => i.series.id);
    expect(items).not.toContain("midnight-delivery"); // on hold
    expect(items).not.toContain("neon-ronin"); // dropped

    const tower = getSeries("tower-of-quiet-clocks");
    let d = setReadingStatus(demo, tower.id, "on-hold");
    expect(getContinueReading(MOCK_SERIES, d).map((i) => i.series.id)).not.toContain(tower.id);
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).not.toContain(tower.id);
    d = setReadingStatus(d, tower.id, "dropped");
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).not.toContain(tower.id);
    d = setReadingStatus(d, tower.id, "reading");
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).toContain(tower.id);
  });

  it("lists recent, unread chapters only for library series", () => {
    const ids = getNewChapters(MOCK_SERIES, demo).map((i) => i.series.id);
    expect(ids).toContain("tower-of-quiet-clocks");
    expect(ids).not.toContain("moonlit-pharmacy-not-in-library");
    expect(ids).not.toContain("rooftop-rivals"); // old release dates
  });

  it("drops a series from New Chapters once its recent chapters are completed", () => {
    const tower = getSeries("tower-of-quiet-clocks");
    let d = demo;
    for (const c of tower.chapters) d = recordProgress(d, tower, c.id, c.pageCount - 1, NOW, true);
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).not.toContain(tower.id);
  });

  it("does not drop new chapters just because their final pages were visited", () => {
    const tower = getSeries("tower-of-quiet-clocks");
    let d = demo;
    for (const c of tower.chapters) d = recordProgress(d, tower, c.id, c.pageCount - 1, NOW, false);
    expect(getNewChapters(MOCK_SERIES, d).map((i) => i.series.id)).toContain(tower.id);
  });
});

describe("library & discover filtering", () => {
  const demo = createDemoUserData();

  it("filters the library by every status", () => {
    expect(filterLibrary(MOCK_SERIES, demo, "completed", "").map((s) => s.id)).toEqual(["rooftop-rivals"]);
    expect(filterLibrary(MOCK_SERIES, demo, "on-hold", "").map((s) => s.id)).toEqual(["midnight-delivery"]);
    expect(filterLibrary(MOCK_SERIES, demo, "dropped", "").map((s) => s.id)).toEqual(["neon-ronin"]);
    expect(filterLibrary(MOCK_SERIES, demo, "planned", "").map((s) => s.id).sort()).toEqual(["ash-and-ember-academy", "moonlit-pharmacy"]);
    expect(filterLibrary(MOCK_SERIES, demo, "reading", "").map((s) => s.id).sort()).toEqual(
      ["last-cartographer", "skyward-lanterns", "tower-of-quiet-clocks"],
    );
    expect(filterLibrary(MOCK_SERIES, demo, "all", "")).toHaveLength(8);
  });

  it("combines status and query, and moves series between filters when status changes", () => {
    expect(filterLibrary(MOCK_SERIES, demo, "all", "tower").map((s) => s.id)).toEqual(["tower-of-quiet-clocks"]);
    expect(filterLibrary(MOCK_SERIES, demo, "all", "zzz")).toEqual([]);
    const d = setReadingStatus(demo, "skyward-lanterns", "on-hold");
    expect(filterLibrary(MOCK_SERIES, d, "on-hold", "").map((s) => s.id).sort()).toEqual(["midnight-delivery", "skyward-lanterns"]);
    expect(filterLibrary(MOCK_SERIES, d, "reading", "").map((s) => s.id)).not.toContain("skyward-lanterns");
  });

  it("only includes series that are in the library", () => {
    const d = addToLibrary(emptyUserData(), "neon-ronin", NOW);
    expect(filterLibrary(MOCK_SERIES, d, "all", "").map((s) => s.id)).toEqual(["neon-ronin"]);
  });

  it("filters library by type (manga, manhwa, manhua) and combines with status", () => {
    // All types
    expect(filterLibrary(MOCK_SERIES, demo, "all", "", "all")).toHaveLength(8);
    // Manga only
    const manga = filterLibrary(MOCK_SERIES, demo, "all", "", "manga");
    expect(manga.every((s) => s.type === "manga")).toBe(true);
    // Manhwa only
    const manhwa = filterLibrary(MOCK_SERIES, demo, "all", "", "manhwa");
    expect(manhwa.every((s) => s.type === "manhwa")).toBe(true);
    // Combined: reading + manhwa
    const readingManhwa = filterLibrary(MOCK_SERIES, demo, "reading", "", "manhwa");
    expect(readingManhwa.every((s) => s.type === "manhwa" && demo.library[s.id]?.status === "reading")).toBe(true);
  });

  it("sorts library deterministically by recent-active, recent-added, title-asc, title-desc, and progress", () => {
    // title-asc
    const asc = filterLibrary(MOCK_SERIES, demo, "all", "", "all", "title-asc");
    for (let i = 0; i < asc.length - 1; i++) {
      expect(asc[i]!.title.localeCompare(asc[i + 1]!.title)).toBeLessThanOrEqual(0);
    }

    // title-desc
    const desc = filterLibrary(MOCK_SERIES, demo, "all", "", "all", "title-desc");
    for (let i = 0; i < desc.length - 1; i++) {
      expect(desc[i]!.title.localeCompare(desc[i + 1]!.title)).toBeGreaterThanOrEqual(0);
    }

    // recent-added
    const added = filterLibrary(MOCK_SERIES, demo, "all", "", "all", "recent-added");
    for (let i = 0; i < added.length - 1; i++) {
      const ta = demo.library[added[i]!.id]!.addedAt;
      const tb = demo.library[added[i + 1]!.id]!.addedAt;
      expect(ta.localeCompare(tb)).toBeGreaterThanOrEqual(0);
    }

    // progress
    const progressSorted = filterLibrary(MOCK_SERIES, demo, "all", "", "all", "progress");
    // Rooftop Rivals has 100% progress completed, so it should be near or at the top
    expect(progressSorted[0]!.id).toBe("rooftop-rivals");
  });

  it("sorts external AniList titles with recorded reading activity above unread titles in progress sort", () => {
    const externalWithActivity: Series = {
      id: "al-101",
      title: "Moonlit Pharmacy (Fixture)",
      type: "manga",
      author: "Yuna Ashida",
      year: 2022,
      status: "ongoing",
      genres: ["Slice of Life"],
      hue: 168,
      description: "A pharmacist serves ghosts.",
      chapters: [], // external title has no complete chapter manifest
      source: "anilist",
    };
    const unreadCatalogSeries = MOCK_SERIES.find((s) => s.id === "ash-and-ember-academy")!;
    const unreadExternalSeries: Series = {
      id: "al-202",
      title: "Tap-eui Sigye",
      type: "manhwa",
      author: "Unknown",
      year: 2024,
      status: "completed",
      genres: [],
      hue: 200,
      description: "",
      chapters: [],
      source: "anilist",
    };

    const combinedCatalog: Series[] = [unreadCatalogSeries, externalWithActivity, unreadExternalSeries];
    let data = emptyUserData();
    data = {
      ...data,
      library: {
        "ash-and-ember-academy": { seriesId: "ash-and-ember-academy", status: "planned", addedAt: NOW },
        "al-101": { seriesId: "al-101", status: "reading", addedAt: NOW },
        "al-202": { seriesId: "al-202", status: "planned", addedAt: NOW },
      },
      progress: {
        "al-101": {
          lastChapterId: "md-chap-1",
          updatedAt: NOW,
          chapters: {
            "md-chap-1": { page: 12, pageCount: 24, completed: true, atEnd: true, updatedAt: NOW },
          },
        },
      },
    };

    const sorted = filterLibrary(combinedCatalog, data, "all", "", "all", "progress");
    // al-101 (with actual recorded activity) must rank above the unread titles
    expect(sorted[0]!.id).toBe("al-101");
    // Both unread titles rank below al-101
    expect(sorted.slice(1).map((s) => s.id)).toEqual(
      expect.arrayContaining(["ash-and-ember-academy", "al-202"]),
    );
  });

  it("searches the catalog by title, author or genre, with a type filter", () => {
    expect(searchCatalog(MOCK_SERIES, "neon", "all").map((s) => s.id)).toEqual(["neon-ronin"]);
    expect(searchCatalog(MOCK_SERIES, "seo ji-woo", "all").map((s) => s.id)).toEqual(["last-cartographer"]);
    expect(searchCatalog(MOCK_SERIES, "", "manhwa").every((s) => s.type === "manhwa")).toBe(true);
    expect(searchCatalog(MOCK_SERIES, "mystery", "manga").map((s) => s.id)).toEqual(["moonlit-pharmacy"]);
  });
});
