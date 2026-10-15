import type {
  ChapterProgress,
  LibraryEntry,
  ReaderMode,
  SavedTitle,
  SeriesProgress,
  UserData,
} from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";

/**
 * Pure, deterministic conflict resolution for cloud sync.
 *
 * Contract: `mergeUserData(a, b)` and `mergeUserData(b, a)` produce equal data
 * and merging the result again changes nothing, so devices converge whatever the
 * order of sync. Semantics (also in docs/sync-conflict-semantics.md):
 *
 * - Library status: per entry, the newer change time (`updatedAt`, else
 *   `addedAt` for data saved before sync) wins. Equal times pick the greater
 *   status string, which is arbitrary but identical on every device.
 * - Deletion: a tombstone (`seriesId -> deletedAt`) removes an entry unless the
 *   entry changed *after* the deletion (a re-add or later edit). Equal times:
 *   the deletion wins. Progress and saved titles are kept on deletion, so a
 *   re-added title still has its history.
 * - Chapter progress: the newer record decides `page`, `pageCount` and `atEnd`,
 *   so turning back a page is not undone by an older, further position.
 *   `completed` is sticky: once any device finished a chapter it stays finished
 *   (the same rule `recordProgress` applies locally). Mark-unread is not a
 *   supported operation; see the design note in the semantics doc.
 * - Series progress: the newer series record decides `lastChapterId`.
 * - Reader mode: per series, the newer choice (`readerModeTimes`) wins; a mode
 *   with no time loses to any timestamped one.
 * - Saved titles: the newer `fetchedAt` wins.
 *
 * Known limit: "newer" trusts device clocks. A device with a clock far in the
 * future wins conflicts until the others catch up.
 */

const time = (value: string | undefined): number => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Effective change time of a library entry (older data has no `updatedAt`). */
export const entryTime = (entry: LibraryEntry): number => time(entry.updatedAt ?? entry.addedAt);

const laterString = (a: string | undefined, b: string | undefined): string | undefined =>
  time(a) >= time(b) ? (a ?? b) : b;

function mergeEntry(a: LibraryEntry, b: LibraryEntry): LibraryEntry {
  const ta = entryTime(a);
  const tb = entryTime(b);
  if (ta !== tb) return ta > tb ? a : b;
  if (a.status !== b.status) return a.status > b.status ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

function mergeChapter(a: ChapterProgress, b: ChapterProgress): ChapterProgress {
  const ta = time(a.updatedAt);
  const tb = time(b.updatedAt);
  let winner: ChapterProgress;
  if (ta !== tb) winner = ta > tb ? a : b;
  else if (a.page !== b.page) winner = a.page > b.page ? a : b;
  else if (a.atEnd !== b.atEnd) winner = a.atEnd ? a : b;
  else winner = a.pageCount >= b.pageCount ? a : b;
  return {
    page: winner.page,
    pageCount: winner.pageCount,
    atEnd: winner.atEnd,
    completed: a.completed || b.completed,
    updatedAt: (laterString(a.updatedAt, b.updatedAt) ?? winner.updatedAt),
  };
}

function mergeSeriesProgress(a: SeriesProgress, b: SeriesProgress): SeriesProgress {
  const chapters: Record<string, ChapterProgress> = { ...a.chapters };
  for (const [id, chapter] of Object.entries(b.chapters || {})) {
    const existing = chapters[id];
    chapters[id] = existing ? mergeChapter(existing, chapter) : chapter;
  }
  const ta = time(a.updatedAt);
  const tb = time(b.updatedAt);
  const winner = ta !== tb ? (ta > tb ? a : b) : a.lastChapterId >= b.lastChapterId ? a : b;
  return {
    lastChapterId: winner.lastChapterId,
    updatedAt: laterString(a.updatedAt, b.updatedAt) ?? winner.updatedAt,
    chapters,
  };
}

function mergeSavedTitle(a: SavedTitle, b: SavedTitle): SavedTitle {
  const ta = time(a.fetchedAt);
  const tb = time(b.fetchedAt);
  if (ta !== tb) return ta > tb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

export function mergeUserData(local: UserData, remote?: Partial<UserData> | null): UserData {
  if (!remote) return { ...local };

  // Tombstones: union, newest deletion time per series.
  const tombstones: Record<string, string> = { ...(local.tombstones || {}) };
  for (const [id, deletedAt] of Object.entries(remote.tombstones || {})) {
    const existing = tombstones[id];
    if (!existing || time(deletedAt) > time(existing)) tombstones[id] = deletedAt;
  }

  // Library: newest entry per series, then reconcile with deletions.
  const candidates: Record<string, LibraryEntry> = { ...local.library };
  for (const [id, entry] of Object.entries(remote.library || {})) {
    const existing = candidates[id];
    candidates[id] = existing ? mergeEntry(existing, entry) : entry;
  }
  const library: Record<string, LibraryEntry> = {};
  for (const [id, entry] of Object.entries(candidates)) {
    const deletedAt = tombstones[id];
    if (deletedAt === undefined) {
      library[id] = entry;
    } else if (entryTime(entry) > time(deletedAt)) {
      library[id] = entry; // changed after the deletion: keep it and retire the tombstone
      delete tombstones[id];
    } // else: the deletion wins
  }

  const progress: Record<string, SeriesProgress> = { ...local.progress };
  for (const [id, series] of Object.entries(remote.progress || {})) {
    const existing = progress[id];
    progress[id] = existing ? mergeSeriesProgress(existing, series) : series;
  }

  const readerModes: Record<string, ReaderMode> = {};
  const readerModeTimes: Record<string, string> = {};
  const localTimes = local.readerModeTimes || {};
  const remoteTimes = remote.readerModeTimes || {};
  const remoteModes = remote.readerModes || {};
  for (const id of new Set([...Object.keys(local.readerModes), ...Object.keys(remoteModes)])) {
    const a = local.readerModes[id];
    const b = remoteModes[id];
    let chosen: ReaderMode | undefined;
    if (a === undefined) chosen = b;
    else if (b === undefined) chosen = a;
    else {
      const ta = time(localTimes[id]);
      const tb = time(remoteTimes[id]);
      chosen = ta !== tb ? (ta > tb ? a : b) : a >= b ? a : b;
    }
    if (chosen === undefined) continue;
    readerModes[id] = chosen;
    const stamp = laterString(localTimes[id], remoteTimes[id]);
    if (stamp !== undefined) readerModeTimes[id] = stamp;
  }

  const savedTitles: Record<string, SavedTitle> = { ...local.savedTitles };
  for (const [id, title] of Object.entries(remote.savedTitles || {})) {
    const existing = savedTitles[id];
    savedTitles[id] = existing ? mergeSavedTitle(existing, title) : title;
  }

  return {
    version: USER_DATA_VERSION,
    library,
    progress,
    readerModes,
    ...(Object.keys(readerModeTimes).length > 0 ? { readerModeTimes } : {}),
    savedTitles,
    tombstones,
    seeded: Boolean(local.seeded || remote.seeded),
  };
}
