import { MOCK_NOW, NEW_CHAPTER_WINDOW_DAYS } from "@/data/mock-catalog";
import type { Chapter, ReadingStatus, Series, SeriesProgress, UserData } from "@/domain/types";
import { isInactiveStatus } from "./user-data";

export interface ResumeTarget {
  chapter: Chapter;
  /** 0-based page to open on. */
  page: number;
  /** "start" = nothing read yet, "continue" = mid-way, "reread" = caught up / finished */
  kind: "start" | "continue" | "reread";
}

/**
 * Where "Start / Continue reading" should take the user.
 * - Nothing read -> chapter 1, page 1.
 * - Mid-chapter -> same chapter, same page (including the final page: just
 *   being on the last page does NOT finish a chapter).
 * - Reader is at the end of a chapter (`atEnd`) -> start of the next chapter,
 *   or its saved page if it was already partly read.
 * - At the end of the final chapter -> "reread" (caught up).
 */
export function getResumeTarget(series: Series, progress?: SeriesProgress): ResumeTarget | null {
  const first = series.chapters[0];
  if (!first) return null;
  if (!progress) return { chapter: first, page: 0, kind: "start" };

  const idx = series.chapters.findIndex((c) => c.id === progress.lastChapterId);
  if (idx === -1) return { chapter: first, page: 0, kind: "start" };

  const chapter = series.chapters[idx]!;
  const cp = progress.chapters[chapter.id];
  if (!cp) return { chapter, page: 0, kind: "continue" };

  if (cp.atEnd) {
    const next = series.chapters[idx + 1];
    if (next) return { chapter: next, page: getChapterStartPage(next, progress), kind: "continue" };
    return { chapter, page: 0, kind: "reread" };
  }
  return { chapter, page: Math.min(cp.page, chapter.pageCount - 1), kind: "continue" };
}

/**
 * Page a reader should open on for an explicit chapter: where you left off,
 * or the top for unread chapters and chapters you left at their end.
 */
export function getChapterStartPage(chapter: Chapter, progress?: SeriesProgress): number {
  const cp = progress?.chapters[chapter.id];
  if (!cp || cp.atEnd) return 0;
  return Math.max(0, Math.min(cp.page, chapter.pageCount - 1));
}

/** 0..1 across the whole series (completed chapters + fraction of current). */
export function getSeriesProgressFraction(series: Series, progress?: SeriesProgress): number {
  if (!progress || series.chapters.length === 0) return 0;
  let total = 0;
  for (const c of series.chapters) {
    const cp = progress.chapters[c.id];
    if (!cp) continue;
    if (cp.completed) total += 1;
    else total += (cp.page + 1) / c.pageCount;
  }
  return Math.min(1, total / series.chapters.length);
}

export type ChapterState = "unread" | "in-progress" | "read";

export function getChapterState(chapter: Chapter, progress?: SeriesProgress): ChapterState {
  const cp = progress?.chapters[chapter.id];
  if (!cp) return "unread";
  if (cp.completed) return "read";
  return cp.page > 0 ? "in-progress" : "unread";
}

export interface ContinueItem {
  series: Series;
  target: ResumeTarget;
  updatedAt: string;
  fraction: number;
}

/** Series with reading history, most recently read first. */
export function getContinueReading(catalog: Series[], data: UserData): ContinueItem[] {
  const items: ContinueItem[] = [];
  for (const series of catalog) {
    const progress = data.progress[series.id];
    if (!progress) continue;
    const status = data.library[series.id]?.status;
    if (status && isInactiveStatus(status)) continue; // paused / dropped series stay out of the way
    const target = getResumeTarget(series, progress);
    if (!target) continue;
    // Hide fully finished series; they live in the library.
    if (target.kind === "reread") continue;
    items.push({
      series,
      target,
      updatedAt: progress.updatedAt,
      fraction: getSeriesProgressFraction(series, progress),
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface NewChapterItem {
  series: Series;
  /** Unread chapters released inside the "new" window, oldest first. */
  chapters: Chapter[];
  latest: Chapter;
}

const daysBetween = (fromIso: string, toIso: string) =>
  (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;

/** Unread, recently released chapters for series in the library. */
export function getNewChapters(
  catalog: Series[],
  data: UserData,
  now: string = MOCK_NOW,
): NewChapterItem[] {
  const items: NewChapterItem[] = [];
  for (const series of catalog) {
    const entry = data.library[series.id];
    if (!entry || isInactiveStatus(entry.status)) continue;
    const progress = data.progress[series.id];
    const fresh = series.chapters.filter((c) => {
      const age = daysBetween(c.releasedAt, now);
      return age >= 0 && age <= NEW_CHAPTER_WINDOW_DAYS && !progress?.chapters[c.id]?.completed;
    });
    const latest = fresh[fresh.length - 1];
    if (latest) items.push({ series, chapters: fresh, latest });
  }
  return items.sort((a, b) => b.latest.releasedAt.localeCompare(a.latest.releasedAt));
}

/** Library series, most recently added first (paused and dropped series stay out of the way). */
export function getRecentlyAdded(catalog: Series[], data: UserData): Series[] {
  return catalog
    .filter((s) => data.library[s.id] && !isInactiveStatus(data.library[s.id]!.status))
    .sort((a, b) => data.library[b.id]!.addedAt.localeCompare(data.library[a.id]!.addedAt));
}

export type LibraryFilter = "all" | ReadingStatus;
export type LibraryTypeFilter = "all" | Series["type"];
export type LibrarySort = "recent-active" | "recent-added" | "title-asc" | "title-desc" | "progress";

export function filterLibrary(
  catalog: Series[],
  data: UserData,
  filter: LibraryFilter = "all",
  query: string = "",
  typeFilter: LibraryTypeFilter = "all",
  sort: LibrarySort = "recent-active",
): Series[] {
  const q = query.trim().toLowerCase();
  return catalog
    .filter((s) => data.library[s.id])
    .filter((s) => filter === "all" || data.library[s.id]!.status === filter)
    .filter((s) => typeFilter === "all" || s.type === typeFilter)
    .filter((s) => !q || matchesQuery(s, q))
    .sort((a, b) => {
      if (sort === "recent-added") {
        const diff = data.library[b.id]!.addedAt.localeCompare(data.library[a.id]!.addedAt);
        if (diff !== 0) return diff;
        return a.title.localeCompare(b.title);
      }
      if (sort === "title-asc") {
        const diff = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      }
      if (sort === "title-desc") {
        const diff = b.title.localeCompare(a.title, undefined, { sensitivity: "base" });
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      }
      if (sort === "progress") {
        const fa = getSeriesProgressFraction(a, data.progress[a.id]);
        const fb = getSeriesProgressFraction(b, data.progress[b.id]);
        if (fb !== fa) return fb - fa;

        const hasA = data.progress[a.id] ? 1 : 0;
        const hasB = data.progress[b.id] ? 1 : 0;
        if (hasB !== hasA) return hasB - hasA;

        const ta = data.progress[a.id]?.updatedAt ?? data.library[a.id]!.addedAt;
        const tb = data.progress[b.id]?.updatedAt ?? data.library[b.id]!.addedAt;
        const diff = tb.localeCompare(ta);
        if (diff !== 0) return diff;
        return a.title.localeCompare(b.title);
      }
      // "recent-active" default
      const ta = data.progress[a.id]?.updatedAt ?? data.library[a.id]!.addedAt;
      const tb = data.progress[b.id]?.updatedAt ?? data.library[b.id]!.addedAt;
      const diff = tb.localeCompare(ta);
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title);
    });
}

export function matchesQuery(series: Series, lowerQuery: string): boolean {
  if (!lowerQuery) return true;
  return (
    series.title.toLowerCase().includes(lowerQuery) ||
    series.author.toLowerCase().includes(lowerQuery) ||
    series.genres.some((g) => g.toLowerCase().includes(lowerQuery))
  );
}

export function searchCatalog(
  catalog: Series[],
  query: string,
  type: "all" | Series["type"],
): Series[] {
  const q = query.trim().toLowerCase();
  return catalog.filter((s) => (type === "all" || s.type === type) && matchesQuery(s, q));
}
