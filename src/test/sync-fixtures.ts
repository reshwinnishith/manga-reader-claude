import type { SavedTitle, UserData } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";

export const TEST_USER = { uid: "u1", isAnonymous: true, metadata: { creationTime: "2026-01-01T00:00:00.000Z" } };
export const DB = {} as import("firebase/firestore").Firestore;

export const title = (n: number, descriptionBytes = 40): SavedTitle => ({
  id: `al-${n}`, source: "anilist", externalId: n, title: `Title ${n}`, type: "manga",
  description: "d".repeat(descriptionBytes), genres: ["Drama"], authors: ["Author"], status: "completed",
  url: `https://anilist.co/manga/${n}`, fetchedAt: "2026-10-01T00:00:00.000Z",
});

/** A library of `count` titles, each with progress, starting at id offset `from`. */
export function library(count: number, from = 0, descriptionBytes = 40, at = "2026-10-01T00:00:00.000Z"): UserData {
  const data = emptyUserData();
  for (let i = from; i < from + count; i++) {
    const id = `al-${i}`;
    data.library[id] = { seriesId: id, status: "reading", addedAt: at, updatedAt: at };
    data.savedTitles[id] = title(i, descriptionBytes);
    data.progress[id] = { lastChapterId: "c1", updatedAt: at, chapters: { c1: { page: 3, pageCount: 20, atEnd: false, completed: false, updatedAt: at } } };
  }
  return data;
}
