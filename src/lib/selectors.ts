import { MOCK_NOW, NEW_CHAPTER_WINDOW_DAYS } from "@/data/mock-catalog";
import type { Chapter, ReadingStatus, Series, SeriesProgress, UserData } from "@/domain/types";
import { isLastPage } from "./user-data";

export interface ResumeTarget {
  chapter: Chapter;
  /** 0-based page to open on. */
  page: number;
  /** "start" = nothing read yet, "continue" = mid-way, "reread" = everything finished */
  kind: "start" | "continue" | "reread";
}

/**
 * Where "Start / Continue reading" should take the user.
 * - Nothing read -> chapter 1, page 1.
 * - Mid-chapter -> same chapter, same page.
 * - Last page of a chapter reached -> next chapter from the top.
 * - Whole series finished -> last chapter's first page ("reread").
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

  if (isLastPage(cp.page, chapter.pageCount)) {
    const next = series.chapters[idx + 1];
    if (next) {
      // Prefer partial progress in the next chapter if there is some.
      const np = progress.chapters[next.id];
      const resumePage = np && !isLastPage(np.page, next.pageCount) ? np.page : 0;
      return { chapter: next, page: resumePage, kind: "continue" };
    }
    return { chapter, page: 0, kind: "reread" };
  }
  return { chapter, page: cp.page, kind: "continue" };
}

/** Page a reader should open on for an explicit chapter. */
export function getChapterStartPage(chapter: Chapter, progress?: SeriesProgress): number {
  const cp = progress?.chapters[chapter.id];
  if (!cp || isLastPage(cp.page, chapter.pageCount)) return 0;
  return Math.min(cp.page, chapter.pageCount - 1);
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
    if (!data.library[series.id]) continue;
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

/** Library series, most recently added first. */
export function getRecentlyAdded(catalog: Series[], data: UserData): Series[] {
  return catalog
    .filter((s) => data.library[s.id])
    .sort((a, b) => data.library[b.id]!.addedAt.localeCompare(data.library[a.id]!.addedAt));
}

export type LibraryFilter = "all" | ReadingStatus;

export function filterLibrary(
  catalog: Series[],
  data: UserData,
  filter: LibraryFilter,
  query: string,
): Series[] {
  const q = query.trim().toLowerCase();
  return catalog
    .filter((s) => data.library[s.id])
    .filter((s) => filter === "all" || data.library[s.id]!.status === filter)
    .filter((s) => !q || matchesQuery(s, q))
    .sort((a, b) => {
      // Most recently touched first, falling back to when it was added.
      const ta = data.progress[a.id]?.updatedAt ?? data.library[a.id]!.addedAt;
      const tb = data.progress[b.id]?.updatedAt ?? data.library[b.id]!.addedAt;
      return tb.localeCompare(ta);
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
