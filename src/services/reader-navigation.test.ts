import { describe, expect, it } from "vitest";
import { readerNeighbors, type MangaDexChapter } from "./mangadex";

const uuid = (n: number) => `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`;
const chapter = (id: number, number: string, extra: Partial<MangaDexChapter> = {}): MangaDexChapter => ({
  id: uuid(id), number, title: "", language: "en", groupNames: ["Team"], url: "https://mangadex.org", readable: true, publishedAt: "2026-01-01", ...extra,
});
const external = (id: number, number: string) => chapter(id, number, { readable: false, externalUrl: "https://publisher.example/read" });
const numbers = (feed: MangaDexChapter[], id: number) => {
  const { previous, next } = readerNeighbors(feed, uuid(id));
  return [previous?.number, next?.number];
};

describe("reader previous/next", () => {
  it("never repeats a chapter that several groups uploaded", () => {
    // Two groups per chapter, in both feed orders.
    const feed = [chapter(1, "1", { groupNames: ["A"] }), chapter(2, "1", { groupNames: ["B"] }), chapter(3, "2", { groupNames: ["A"] }), chapter(4, "2", { groupNames: ["B"] }), chapter(5, "3")];
    for (const ordered of [feed, [...feed].reverse()]) {
      expect(numbers(ordered, 1)).toEqual([undefined, "2"]);
      expect(numbers(ordered, 2)).toEqual([undefined, "2"]);
      expect(numbers(ordered, 3)).toEqual(["1", "3"]);
      expect(numbers(ordered, 4)).toEqual(["1", "3"]);
      expect(numbers(ordered, 5)).toEqual(["2", undefined]);
    }
  });

  it("chooses the same copy of a duplicate whatever order the feed arrives in", () => {
    const older = chapter(1, "2", { publishedAt: "2020-01-01" });
    const newer = chapter(2, "2", { publishedAt: "2024-01-01" });
    const one = chapter(3, "1");
    for (const feed of [[one, older, newer], [newer, older, one], [older, one, newer]]) {
      expect(readerNeighbors(feed, uuid(3)).next?.id).toBe(newer.id); // newest upload wins, not feed order
    }
    // A reader who is already on the older copy keeps it as their position.
    expect(readerNeighbors([one, older, newer], older.id).previous?.id).toBe(one.id);
  });

  it("keeps genuinely different content: other volumes, decimals and numberless specials", () => {
    const feed = [
      chapter(1, "1", { volume: "1" }), chapter(2, "1", { volume: "2" }), // restarted numbering
      chapter(3, "54"), chapter(4, "54.2"),
      chapter(5, "", { title: "Special A", publishedAt: "2026-01-01" }), chapter(6, "", { title: "Special B", publishedAt: "2026-02-01" }),
    ];
    expect(numbers(feed, 1)).toEqual([undefined, "1"]);
    expect(readerNeighbors(feed, uuid(1)).next?.id).toBe(uuid(2));
    expect(numbers(feed, 3)).toEqual(["1", "54.2"]);
    expect(numbers(feed, 4)).toEqual(["54", ""]);
    expect(readerNeighbors(feed, uuid(5)).next?.id).toBe(uuid(6));
  });

  it("skips external-only, withheld and unavailable chapters", () => {
    const feed = [chapter(1, "1"), external(2, "2"), chapter(3, "3"), chapter(4, "4", { readable: false }), chapter(5, "5")];
    expect(numbers(feed, 1)).toEqual([undefined, "3"]);
    expect(numbers(feed, 3)).toEqual(["1", "5"]);
    expect(numbers(feed, 5)).toEqual(["3", undefined]);
  });

  it("does not let an external copy shadow, or be preferred over, a readable one", () => {
    const feed = [chapter(1, "1"), external(2, "2"), chapter(3, "2"), chapter(4, "3")];
    expect(readerNeighbors(feed, uuid(1)).next?.id).toBe(uuid(3));
    expect(readerNeighbors(feed, uuid(4)).previous?.id).toBe(uuid(3));
  });

  it("offers no navigation when the current chapter is not readable or not in the feed", () => {
    const feed = [chapter(1, "1"), external(2, "2"), chapter(3, "3")];
    expect(readerNeighbors(feed, uuid(2))).toEqual({});
    expect(readerNeighbors(feed, uuid(9))).toEqual({});
    expect(readerNeighbors([], uuid(1))).toEqual({});
  });
});
