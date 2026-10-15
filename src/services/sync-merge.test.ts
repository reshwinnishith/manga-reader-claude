import { describe, expect, it } from "vitest";
import type { ChapterProgress, LibraryEntry, ReaderMode, ReadingStatus, UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";
import { addToLibrary, emptyUserData, migrateUserData, recordProgress, removeFromLibrary, setReaderMode, setReadingStatus } from "@/lib/user-data";
import { getSeries } from "@/test/helpers";
import { canonicalStringify } from "./sync-snapshot";
import { mergeUserData } from "./sync-merge";

const T = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
const base = (over: Partial<UserData> = {}): UserData => ({ ...emptyUserData(), ...over });
const entry = (status: ReadingStatus, addedAt: string, updatedAt?: string): LibraryEntry => ({ seriesId: "s", status, addedAt, ...(updatedAt ? { updatedAt } : {}) });
const chapter = (page: number, updatedAt: string, extra: Partial<ChapterProgress> = {}): ChapterProgress => ({ page, pageCount: 20, atEnd: false, completed: false, updatedAt, ...extra });
const withProgress = (chapters: Record<string, ChapterProgress>, lastChapterId: string, updatedAt: string): UserData =>
  base({ progress: { s: { lastChapterId, updatedAt, chapters } } });
const same = (a: UserData, b: UserData) => expect(canonicalStringify(a)).toBe(canonicalStringify(b));

describe("conflict semantics: reading status", () => {
  it("the newer status change wins, whichever side it is on", () => {
    const planned = base({ library: { s: entry("planned", T(0), T(0)) } });
    const reading = base({ library: { s: entry("reading", T(0), T(5)) } });
    expect(mergeUserData(planned, reading).library.s?.status).toBe("reading");
    expect(mergeUserData(reading, planned).library.s?.status).toBe("reading");
  });

  it("a status edit is no longer lost to a stale copy with the same addedAt (the old addedAt-only rule)", () => {
    const stale = base({ library: { s: entry("planned", T(0)) } });
    const edited = base({ library: { s: entry("dropped", T(0), T(9)) } });
    expect(mergeUserData(stale, edited).library.s?.status).toBe("dropped");
    expect(mergeUserData(edited, stale).library.s?.status).toBe("dropped");
  });

  it("entries saved before sync existed (no updatedAt) compare by addedAt", () => {
    const older = base({ library: { s: entry("planned", T(1)) } });
    const newer = base({ library: { s: entry("reading", T(4)) } });
    expect(mergeUserData(older, newer).library.s?.status).toBe("reading");
    expect(mergeUserData(newer, older).library.s?.status).toBe("reading");
  });

  it("equal times pick the same status on every device", () => {
    const a = base({ library: { s: entry("reading", T(2), T(3)) } });
    const b = base({ library: { s: entry("on-hold", T(2), T(3)) } });
    expect(mergeUserData(a, b).library.s?.status).toBe(mergeUserData(b, a).library.s?.status);
  });
});

describe("conflict semantics: deletion", () => {
  it("a deletion newer than the entry removes it, and keeps progress for a later re-add", () => {
    const device = base({ library: { s: entry("reading", T(0), T(2)) }, progress: { s: { lastChapterId: "c", updatedAt: T(2), chapters: { c: chapter(3, T(2)) } } } });
    const deleted = removeFromLibrary(device, "s", T(5));
    const merged = mergeUserData(device, deleted);
    expect(merged.library.s).toBeUndefined();
    expect(merged.tombstones?.s).toBe(T(5));
    expect(merged.progress.s?.chapters.c?.page).toBe(3);
    same(mergeUserData(deleted, device), merged);
  });

  it("an entry changed after the deletion survives and retires the tombstone", () => {
    const deleted = base({ tombstones: { s: T(5) } });
    const readded = base({ library: { s: entry("planned", T(8), T(8)) } });
    for (const merged of [mergeUserData(deleted, readded), mergeUserData(readded, deleted)]) {
      expect(merged.library.s?.status).toBe("planned");
      expect(merged.tombstones?.s).toBeUndefined();
    }
  });

  it("a status edit made after the deletion time also survives", () => {
    const deleted = base({ tombstones: { s: T(5) } });
    const edited = base({ library: { s: entry("reading", T(0), T(7)) } });
    expect(mergeUserData(deleted, edited).library.s?.status).toBe("reading");
  });

  it("equal times: the deletion wins, on every device", () => {
    const deleted = base({ tombstones: { s: T(5) } });
    const entryAtSameTime = base({ library: { s: entry("reading", T(0), T(5)) } });
    expect(mergeUserData(deleted, entryAtSameTime).library.s).toBeUndefined();
    expect(mergeUserData(entryAtSameTime, deleted).library.s).toBeUndefined();
  });
});

describe("conflict semantics: chapter progress and mark-unread", () => {
  it("the newer record decides the position: going back a page is not undone by an older, further one", () => {
    const further = withProgress({ c: chapter(15, T(1)) }, "c", T(1));
    const wentBack = withProgress({ c: chapter(4, T(6)) }, "c", T(6));
    expect(mergeUserData(further, wentBack).progress.s?.chapters.c?.page).toBe(4);
    expect(mergeUserData(wentBack, further).progress.s?.chapters.c?.page).toBe(4);
  });

  it("completion is sticky: a newer, not-completed record never un-finishes a chapter", () => {
    const finished = withProgress({ c: chapter(19, T(2), { atEnd: true, completed: true }) }, "c", T(2));
    const staleReader = withProgress({ c: chapter(1, T(9)) }, "c", T(9)); // reopened later on a device that never saw the finish
    for (const merged of [mergeUserData(finished, staleReader), mergeUserData(staleReader, finished)]) {
      const c = merged.progress.s?.chapters.c;
      expect(c?.completed).toBe(true);
      expect(c?.page).toBe(1); // position still follows the newer record
      expect(c?.atEnd).toBe(false);
    }
  });

  it("leaving the end (atEnd false) on the newer record is respected without losing completion", () => {
    const atEnd = withProgress({ c: chapter(19, T(2), { atEnd: true, completed: true }) }, "c", T(2));
    const leftEnd = withProgress({ c: chapter(18, T(3), { completed: true }) }, "c", T(3));
    expect(mergeUserData(atEnd, leftEnd).progress.s?.chapters.c).toMatchObject({ page: 18, atEnd: false, completed: true });
  });

  it("chapters merge independently and lastChapterId follows the newer series record", () => {
    const a = withProgress({ c1: chapter(5, T(1)) }, "c1", T(1));
    const b = withProgress({ c2: chapter(2, T(4)) }, "c2", T(4));
    const merged = mergeUserData(a, b);
    expect(Object.keys(merged.progress.s!.chapters).sort()).toEqual(["c1", "c2"]);
    expect(merged.progress.s?.lastChapterId).toBe("c2");
    same(mergeUserData(b, a), merged);
  });
});

describe("conflict semantics: reader modes", () => {
  const modes = (mode: ReaderMode, at?: string): UserData => base({ readerModes: { s: mode }, ...(at ? { readerModeTimes: { s: at } } : {}) });

  it("the most recent choice wins per series, on either side", () => {
    expect(mergeUserData(modes("vertical", T(1)), modes("paged-rtl", T(5))).readerModes.s).toBe("paged-rtl");
    expect(mergeUserData(modes("paged-rtl", T(5)), modes("vertical", T(1))).readerModes.s).toBe("paged-rtl");
  });

  it("a mode with no time (saved before sync) loses to any timestamped choice, and local no longer always wins", () => {
    expect(mergeUserData(modes("vertical"), modes("paged-rtl", T(1))).readerModes.s).toBe("paged-rtl");
    expect(mergeUserData(modes("paged-rtl", T(1)), modes("vertical")).readerModes.s).toBe("paged-rtl");
  });

  it("modes that exist on only one side are kept, with their times", () => {
    const merged = mergeUserData(base({ readerModes: { a: "vertical" }, readerModeTimes: { a: T(1) } }), base({ readerModes: { b: "paged-rtl" } }));
    expect(merged.readerModes).toEqual({ a: "vertical", b: "paged-rtl" });
    expect(merged.readerModeTimes).toEqual({ a: T(1) });
  });

  it("equal times pick the same mode on every device", () => {
    expect(mergeUserData(modes("vertical", T(2)), modes("paged-rtl", T(2))).readerModes.s).toBe(mergeUserData(modes("paged-rtl", T(2)), modes("vertical", T(2))).readerModes.s);
  });
});

describe("merge is commutative and idempotent (devices converge in any sync order)", () => {
  // A small seeded generator so failures reproduce.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const make = (rand: () => number): UserData => {
    const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)]!;
    const time = () => T(Math.floor(rand() * 6));
    const statuses: ReadingStatus[] = ["reading", "planned", "on-hold", "dropped", "completed"];
    const data = emptyUserData();
    for (const id of ["a", "b", "c"]) {
      if (rand() < 0.7) data.library[id] = { seriesId: id, status: pick(statuses), addedAt: time(), ...(rand() < 0.6 ? { updatedAt: time() } : {}) };
      if (rand() < 0.3) data.tombstones = { ...data.tombstones, [id]: time() };
      if (rand() < 0.6) {
        const chapters: Record<string, ChapterProgress> = {};
        for (const ch of ["1", "2"]) if (rand() < 0.7) chapters[ch] = { page: Math.floor(rand() * 10), pageCount: pick([10, 12]), atEnd: rand() < 0.3, completed: rand() < 0.3, updatedAt: time() };
        data.progress[id] = { lastChapterId: pick(["1", "2"]), updatedAt: time(), chapters };
      }
      if (rand() < 0.5) {
        data.readerModes[id] = pick<ReaderMode>(["vertical", "paged-rtl"]);
        if (rand() < 0.6) data.readerModeTimes = { ...data.readerModeTimes, [id]: time() };
      }
    }
    data.seeded = rand() < 0.5;
    return data;
  };

  it("holds for 300 random pairs", () => {
    const rand = rng(20261015);
    for (let i = 0; i < 300; i++) {
      const a = make(rand);
      const b = make(rand);
      const ab = mergeUserData(a, b);
      same(ab, mergeUserData(b, a));
      same(mergeUserData(ab, b), ab);
      same(mergeUserData(ab, a), ab);
    }
  });

  it("holds for three-way merges in any order", () => {
    const rand = rng(77);
    for (let i = 0; i < 100; i++) {
      const [a, b, c] = [make(rand), make(rand), make(rand)] as [UserData, UserData, UserData];
      const left = mergeUserData(mergeUserData(a, b), c);
      same(left, mergeUserData(a, mergeUserData(b, c)));
      same(left, mergeUserData(mergeUserData(c, a), b));
    }
  });
});

describe("existing data and migrations are preserved", () => {
  it("a library saved before updatedAt/readerModeTimes existed loads unchanged and merges by addedAt", () => {
    const legacy = {
      version: USER_DATA_VERSION,
      library: { s: { seriesId: "s", status: "reading", addedAt: T(3) } },
      progress: { s: { lastChapterId: "c", updatedAt: T(3), chapters: { c: { page: 2, pageCount: 9, atEnd: false, completed: false, updatedAt: T(3) } } } },
      readerModes: { s: "vertical" },
      savedTitles: {},
      seeded: true,
    };
    const migrated = migrateUserData(JSON.parse(JSON.stringify(legacy)))!;
    expect(migrated.library.s).toEqual({ seriesId: "s", status: "reading", addedAt: T(3) });
    expect(migrated.readerModes).toEqual({ s: "vertical" });
    expect(migrated.progress.s?.chapters.c?.page).toBe(2);
    expect(migrated.readerModeTimes).toBeUndefined();
    expect(migrated.seeded).toBe(true);
    expect(mergeUserData(migrated, base({ library: { s: entry("dropped", T(1)) } })).library.s?.status).toBe("reading");
  });

  it("keeps valid updatedAt / readerModeTimes and drops invalid ones", () => {
    const migrated = migrateUserData({
      version: USER_DATA_VERSION,
      library: { a: { seriesId: "a", status: "reading", addedAt: T(1), updatedAt: T(4) }, b: { seriesId: "b", status: "planned", addedAt: T(1), updatedAt: "not a date" } },
      progress: {},
      readerModes: { a: "vertical", b: "paged-rtl" },
      readerModeTimes: { a: T(2), b: "nope", ghost: T(3) },
      savedTitles: {},
      seeded: false,
    })!;
    expect(migrated.library.a?.updatedAt).toBe(T(4));
    expect(migrated.library.b?.updatedAt).toBeUndefined();
    expect(migrated.readerModeTimes).toEqual({ a: T(2) });
  });

  it("local operations stamp changes: status edits and reader modes, but not page turns", () => {
    let d = addToLibrary(emptyUserData(), "demo", T(1), "planned");
    expect(d.library.demo?.updatedAt).toBe(T(1));
    d = setReadingStatus(d, "demo", "on-hold", T(3));
    expect(d.library.demo).toMatchObject({ status: "on-hold", addedAt: T(1), updatedAt: T(3) });
    expect(setReadingStatus(d, "demo", "on-hold", T(9))).toBe(d); // unchanged status: no new time
    d = setReaderMode(d, "demo", "paged-rtl", T(4));
    expect(d.readerModeTimes?.demo).toBe(T(4));
    expect(setReaderMode(d, "demo", "paged-rtl", T(9))).toBe(d);

    const series = getSeries("neon-ronin");
    const chapterId = series.chapters[0]!.id;
    let p = addToLibrary(emptyUserData(), series.id, T(1), "planned");
    p = recordProgress(p, series, chapterId, 1, T(5)); // planned -> reading is a status change
    expect(p.library[series.id]).toMatchObject({ status: "reading", updatedAt: T(5) });
    p = recordProgress(p, series, chapterId, 2, T(8)); // a page turn is not
    expect(p.library[series.id]?.updatedAt).toBe(T(5));
  });
});
