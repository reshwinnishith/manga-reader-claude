/**
 * Domain model. Everything here is plain serialisable data so it can later be
 * stored in Firestore or fetched from a permitted source adapter unchanged.
 */

export type SeriesType = "manga" | "manhwa";
export type PublicationStatus = "ongoing" | "completed" | "hiatus";
export type ReaderMode = "vertical" | "paged-rtl";
export type ReadingStatus = "reading" | "planned" | "on-hold" | "dropped" | "completed";

/** Display order and labels for reading statuses (filters, status picker). */
export const READING_STATUSES: { value: ReadingStatus; label: string }[] = [
  { value: "reading", label: "Reading" },
  { value: "planned", label: "Planned" },
  { value: "on-hold", label: "On Hold" },
  { value: "dropped", label: "Dropped" },
  { value: "completed", label: "Completed" },
];

/** Statuses the user has paused or abandoned: no nudges on Home. */
export const INACTIVE_STATUSES: readonly ReadingStatus[] = ["on-hold", "dropped"];

export interface Chapter {
  id: string;
  /** Display number, e.g. 12 or 12.5 */
  number: number;
  title: string;
  pageCount: number;
  /** ISO date (YYYY-MM-DD) */
  releasedAt: string;
}

export interface Series {
  id: string;
  title: string;
  type: SeriesType;
  author: string;
  year: number;
  status: PublicationStatus;
  genres: string[];
  description: string;
  /** Drives the generated placeholder cover and pages (0-359). */
  hue: number;
  chapters: Chapter[];
}

/** What the reader should open by default for a series. */
export const defaultReaderMode = (type: SeriesType): ReaderMode =>
  type === "manhwa" ? "vertical" : "paged-rtl";

// ---- User data (progress + library) ---------------------------------------

export interface LibraryEntry {
  seriesId: string;
  status: ReadingStatus;
  /** ISO timestamp */
  addedAt: string;
}

/**
 * Per-chapter reading state.
 *
 * - `page`: 0-based page the reader was last on (never past the final page).
 * - `atEnd`: the reader's *current* position is the end of the chapter (paged:
 *   the end card is showing; vertical: the final page has scrolled past the
 *   middle of the screen). Moving back off the end clears it.
 * - `completed`: the end of the chapter has been reached at least once. This
 *   is sticky: rereading, scrolling back or switching modes never clears it.
 */
export interface ChapterProgress {
  page: number;
  pageCount: number;
  atEnd: boolean;
  completed: boolean;
  updatedAt: string;
}

export interface SeriesProgress {
  lastChapterId: string;
  updatedAt: string;
  chapters: Record<string, ChapterProgress>;
}

/** Bump when the persisted shape changes and add a step to `migrateUserData`. */
export const USER_DATA_VERSION = 2;

export interface UserData {
  version: typeof USER_DATA_VERSION;
  library: Record<string, LibraryEntry>;
  progress: Record<string, SeriesProgress>;
  readerModes: Record<string, ReaderMode>;
  /** True once the demo library has been seeded (never reseed after). */
  seeded: boolean;
}
