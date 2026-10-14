import {
  INACTIVE_STATUSES,
  READING_STATUSES,
  USER_DATA_VERSION,
  type ChapterProgress,
  type LibraryEntry,
  type ReaderMode,
  type ReadingStatus,
  type SavedTitle,
  type Series,
  type UserData,
} from "@/domain/types";

/**
 * Pure state transitions for user data. No I/O and no clock access: callers
 * pass `now` so behaviour is deterministic and unit-testable.
 */

export const emptyUserData = (): UserData => ({
  version: USER_DATA_VERSION,
  library: {},
  progress: {},
  readerModes: {},
  savedTitles: {},
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

/**
 * Save a title found through search and put it in the library as "planned".
 * Existing library entries (status, addedAt) and progress are never touched;
 * the stored metadata snapshot is refreshed.
 */
export function saveExternalTitle(data: UserData, title: SavedTitle, now: string): UserData {
  const withTitle: UserData = { ...data, savedTitles: { ...data.savedTitles, [title.id]: title } };
  return addToLibrary(withTitle, title.id, now);
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

/**
 * Record where the reader is in a chapter.
 *
 * Completion semantics (identical in both reader modes):
 * - `atEnd` is true only when the reader has reached the *end of the chapter*
 *   (past the final page), never merely the final page.
 * - The first time that happens `completed` becomes true, and it never reverts.
 * - Leaving the end (going back a page, scrolling up) clears `atEnd` only.
 * - Recording an unchanged position is a no-op (same object returned), so
 *   repeated events cannot produce duplicate completions or churn storage.
 *
 * Status side effects: reading something moves planned / on-hold / dropped
 * series to "reading"; finishing every chapter of a publication-complete
 * series moves it to "completed"; rereading a completed series leaves it alone.
 */
export function recordProgress(
  data: UserData,
  series: Series,
  chapterId: string,
  page: number,
  now: string,
  atEnd = false,
): UserData {
  const chapter = series.chapters.find((c) => c.id === chapterId);
  if (!chapter) return data;

  const clamped = Math.max(0, Math.min(page, chapter.pageCount - 1));
  const prevSeries = data.progress[series.id];
  const prev = prevSeries?.chapters[chapterId];

  const unchanged =
    prev &&
    prev.page === clamped &&
    prev.atEnd === atEnd &&
    prev.pageCount === chapter.pageCount &&
    prevSeries.lastChapterId === chapterId;
  if (unchanged && data.library[series.id]) return data;

  const chapterProgress: ChapterProgress = {
    page: clamped,
    pageCount: chapter.pageCount,
    atEnd,
    completed: (prev?.completed ?? false) || atEnd,
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
  let status: ReadingStatus = "reading";
  if (finished) status = "completed";
  else if (existing?.status === "completed") status = "completed"; // rereading: keep

  const entry: LibraryEntry = {
    seriesId: series.id,
    addedAt: existing?.addedAt ?? now,
    status,
  };

  return { ...data, progress, library: { ...data.library, [series.id]: entry } };
}

export const isInactiveStatus = (status: ReadingStatus) => INACTIVE_STATUSES.includes(status);

// ---- Persistence migrations ------------------------------------------------

const VALID_STATUSES = new Set<string>(READING_STATUSES.map((s) => s.value));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const SERIES_TYPES = new Set(["manga", "manhwa", "manhua"]);
const PUBLICATION_STATUSES = new Set(["ongoing", "completed", "hiatus", "cancelled", "upcoming"]);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Defensive parse of a stored title snapshot; returns null if unusable. */
function parseSavedTitle(id: string, value: unknown): SavedTitle | null {
  if (!isRecord(value)) return null;
  if (typeof value.title !== "string" || typeof value.externalId !== "number" || value.source !== "anilist") return null;
  if (typeof value.url !== "string" || !/^https:\/\//.test(value.url)) return null;
  return {
    id,
    source: "anilist",
    externalId: value.externalId,
    title: value.title,
    type: typeof value.type === "string" && SERIES_TYPES.has(value.type) ? (value.type as SavedTitle["type"]) : "manga",
    description: typeof value.description === "string" ? value.description : "",
    coverUrl: typeof value.coverUrl === "string" && /^https:\/\//.test(value.coverUrl) ? value.coverUrl : undefined,
    genres: isStringArray(value.genres) ? value.genres : [],
    authors: isStringArray(value.authors) ? value.authors : [],
    year: typeof value.year === "number" ? value.year : undefined,
    status:
      typeof value.status === "string" && PUBLICATION_STATUSES.has(value.status)
        ? (value.status as SavedTitle["status"])
        : "ongoing",
    reportedChapters: typeof value.reportedChapters === "number" ? value.reportedChapters : undefined,
    url: value.url,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : new Date(0).toISOString(),
  };
}

/**
 * Bring any previously persisted shape up to the current `UserData`, keeping
 * everything the user has recorded. Returns null for unrecognisable input.
 *
 * - v2 -> v3: adds `savedTitles` (titles saved from search). Nothing else changes.
 * - v1 -> v2: chapters gain `atEnd`. In v1 a chapter was marked completed on
 *   merely reaching its final page, so a completed chapter parked on its final
 *   page is treated as at its end; completion history is preserved as-is.
 *   Library statuses are unchanged (the new On Hold / Dropped values are
 *   additive); unknown statuses fall back to "reading".
 */
export function migrateUserData(raw: unknown): UserData | null {
  if (!isRecord(raw)) return null;
  const version = raw.version;
  if (version !== 1 && version !== 2 && version !== USER_DATA_VERSION) return null;
  if (!isRecord(raw.library) || !isRecord(raw.progress) || !isRecord(raw.readerModes)) return null;

  const library: UserData["library"] = {};
  for (const [id, value] of Object.entries(raw.library)) {
    if (!isRecord(value)) continue;
    const status = typeof value.status === "string" && VALID_STATUSES.has(value.status) ? value.status : "reading";
    library[id] = {
      seriesId: typeof value.seriesId === "string" ? value.seriesId : id,
      status: status as ReadingStatus,
      addedAt: typeof value.addedAt === "string" ? value.addedAt : new Date(0).toISOString(),
    };
  }

  const progress: UserData["progress"] = {};
  for (const [seriesId, value] of Object.entries(raw.progress)) {
    if (!isRecord(value) || !isRecord(value.chapters) || typeof value.lastChapterId !== "string") continue;
    const chapters: Record<string, ChapterProgress> = {};
    for (const [chapterId, c] of Object.entries(value.chapters)) {
      if (!isRecord(c) || typeof c.page !== "number" || typeof c.pageCount !== "number") continue;
      const completed = c.completed === true;
      const atEnd =
        typeof c.atEnd === "boolean" ? c.atEnd : completed && c.page >= c.pageCount - 1;
      chapters[chapterId] = {
        page: c.page,
        pageCount: c.pageCount,
        atEnd,
        completed,
        updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : new Date(0).toISOString(),
      };
    }
    progress[seriesId] = {
      lastChapterId: value.lastChapterId,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      chapters,
    };
  }

  const readerModes: UserData["readerModes"] = {};
  for (const [id, mode] of Object.entries(raw.readerModes)) {
    if (mode === "vertical" || mode === "paged-rtl") readerModes[id] = mode;
  }

  const savedTitles: UserData["savedTitles"] = {};
  if (isRecord(raw.savedTitles)) {
    for (const [id, value] of Object.entries(raw.savedTitles)) {
      const title = parseSavedTitle(id, value);
      if (title) savedTitles[id] = title;
    }
  }

  return { version: USER_DATA_VERSION, library, progress, readerModes, savedTitles, seeded: raw.seeded === true };
}
