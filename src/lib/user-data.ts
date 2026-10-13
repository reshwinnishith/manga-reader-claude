import type {
  ChapterProgress,
  LibraryEntry,
  ReaderMode,
  ReadingStatus,
  Series,
  UserData,
} from "@/domain/types";

/**
 * Pure state transitions for user data. No I/O and no clock access: callers
 * pass `now` so behaviour is deterministic and unit-testable.
 */

export const emptyUserData = (): UserData => ({
  version: 1,
  library: {},
  progress: {},
  readerModes: {},
  seeded: false,
});

export function addToLibrary(
  data: UserData,
  seriesId: string,
  now: string,
  status: ReadingStatus = "planned",
): UserData {
  if (data.library[seriesId]) return data;
  const entry: LibraryEntry = { seriesId, status, addedAt: now };
  return { ...data, library: { ...data.library, [seriesId]: entry } };
}

export function removeFromLibrary(data: UserData, seriesId: string): UserData {
  if (!data.library[seriesId]) return data;
  const library = { ...data.library };
  delete library[seriesId];
  return { ...data, library };
}

export function setReadingStatus(
  data: UserData,
  seriesId: string,
  status: ReadingStatus,
): UserData {
  const entry = data.library[seriesId];
  if (!entry || entry.status === status) return data;
  return { ...data, library: { ...data.library, [seriesId]: { ...entry, status } } };
}

export function setReaderMode(data: UserData, seriesId: string, mode: ReaderMode): UserData {
  if (data.readerModes[seriesId] === mode) return data;
  return { ...data, readerModes: { ...data.readerModes, [seriesId]: mode } };
}

/** True when the page counts as "finished" for the chapter. */
export const isLastPage = (page: number, pageCount: number) => page >= pageCount - 1;

/**
 * Record that the reader is on `page` (0-based) of a chapter.
 * - Reaching the last page marks the chapter completed (and it stays completed
 *   if the user later re-reads it).
 * - Reading something that is not in the library adds it as "reading";
 *   starting a "planned" series moves it to "reading".
 */
export function recordProgress(
  data: UserData,
  series: Series,
  chapterId: string,
  page: number,
  now: string,
): UserData {
  const chapter = series.chapters.find((c) => c.id === chapterId);
  if (!chapter) return data;

  const clamped = Math.max(0, Math.min(page, chapter.pageCount - 1));
  const prevSeries = data.progress[series.id];
  const prevChapter = prevSeries?.chapters[chapterId];

  const chapterProgress: ChapterProgress = {
    page: clamped,
    pageCount: chapter.pageCount,
    completed: (prevChapter?.completed ?? false) || isLastPage(clamped, chapter.pageCount),
    updatedAt: now,
  };

  const chapters = { ...(prevSeries?.chapters ?? {}), [chapterId]: chapterProgress };
  const progress = {
    ...data.progress,
    [series.id]: { lastChapterId: chapterId, updatedAt: now, chapters },
  };

  const allDone = series.chapters.every((c) => chapters[c.id]?.completed);
  const finished = allDone && series.status === "completed";

  const existing = data.library[series.id];
  const nextStatus: ReadingStatus = finished ? "completed" : "reading";
  const entry: LibraryEntry =
    existing && existing.status === "completed" && !finished
      ? existing // re-reading a completed series: leave the status alone
      : { seriesId: series.id, addedAt: existing?.addedAt ?? now, status: nextStatus };

  return { ...data, progress, library: { ...data.library, [series.id]: entry } };
}
