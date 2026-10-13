/**
 * Domain model. Everything here is plain serialisable data so it can later be
 * stored in Firestore or fetched from a permitted source adapter unchanged.
 */

export type SeriesType = "manga" | "manhwa";
export type PublicationStatus = "ongoing" | "completed" | "hiatus";
export type ReaderMode = "vertical" | "paged-rtl";
export type ReadingStatus = "reading" | "planned" | "completed";

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

export interface ChapterProgress {
  /** 0-based index of the page the reader was last on. */
  page: number;
  pageCount: number;
  completed: boolean;
  updatedAt: string;
}

export interface SeriesProgress {
  lastChapterId: string;
  updatedAt: string;
  chapters: Record<string, ChapterProgress>;
}

export interface UserData {
  version: 1;
  library: Record<string, LibraryEntry>;
  progress: Record<string, SeriesProgress>;
  readerModes: Record<string, ReaderMode>;
  /** True once the demo library has been seeded (never reseed after). */
  seeded: boolean;
}
