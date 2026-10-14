import type { ChapterProgress, UserData } from "@/domain/types";
import { MOCK_SERIES } from "./mock-catalog";
import { emptyUserData } from "@/lib/user-data";

/**
 * First-run demo state so Home and Library are not empty on first launch.
 * Timestamps are anchored to the mock clock for determinism.
 */
const at = (hoursAgo: number) =>
  new Date(Date.parse("2026-10-12T12:00:00Z") - hoursAgo * 3_600_000).toISOString();

function chapterProgress(seriesId: string, doneUpTo: number, current?: { n: number; page: number }, when = 1) {
  const series = MOCK_SERIES.find((s) => s.id === seriesId)!;
  const chapters: Record<string, ChapterProgress> = {};
  series.chapters.forEach((c) => {
    if (c.number <= doneUpTo) {
      chapters[c.id] = { page: c.pageCount - 1, pageCount: c.pageCount, atEnd: true, completed: true, updatedAt: at(when + 1) };
    } else if (current && c.number === current.n) {
      chapters[c.id] = { page: current.page, pageCount: c.pageCount, atEnd: false, completed: false, updatedAt: at(when) };
    }
  });
  const last = current ? current.n : doneUpTo;
  return {
    lastChapterId: `${seriesId}-c${last}`,
    updatedAt: at(when),
    chapters,
  };
}

export function createDemoUserData(): UserData {
  const base = emptyUserData();
  return {
    ...base,
    seeded: true,
    library: {
      "tower-of-quiet-clocks": { seriesId: "tower-of-quiet-clocks", status: "reading", addedAt: at(500) },
      "skyward-lanterns": { seriesId: "skyward-lanterns", status: "reading", addedAt: at(400) },
      "last-cartographer": { seriesId: "last-cartographer", status: "reading", addedAt: at(300) },
      "moonlit-pharmacy": { seriesId: "moonlit-pharmacy", status: "planned", addedAt: at(60) },
      "rooftop-rivals": { seriesId: "rooftop-rivals", status: "completed", addedAt: at(900) },
      "ash-and-ember-academy": { seriesId: "ash-and-ember-academy", status: "planned", addedAt: at(20) },
      "midnight-delivery": { seriesId: "midnight-delivery", status: "on-hold", addedAt: at(700) },
      "neon-ronin": { seriesId: "neon-ronin", status: "dropped", addedAt: at(650) },
    },
    progress: {
      "tower-of-quiet-clocks": chapterProgress("tower-of-quiet-clocks", 10, { n: 11, page: 4 }, 2),
      "skyward-lanterns": chapterProgress("skyward-lanterns", 8, { n: 9, page: 6 }, 30),
      "last-cartographer": chapterProgress("last-cartographer", 7, undefined, 100),
      "rooftop-rivals": chapterProgress("rooftop-rivals", 10, undefined, 800),
      "midnight-delivery": chapterProgress("midnight-delivery", 3, { n: 4, page: 2 }, 400),
      "neon-ronin": chapterProgress("neon-ronin", 1, { n: 2, page: 5 }, 600),
    },
    readerModes: {},
  };
}
