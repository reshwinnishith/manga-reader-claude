import { afterEach, describe, expect, it, vi } from "vitest";
import { listMangaDexChapters, searchMangaDex, selectChapters, type MangaDexChapter } from "./mangadex";
import { mangaDexProvider, officialDestinations } from "./reading-sources";
import { normalizeMedia } from "./anilist";
const uuid = (n: number) => `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const chapter = (id: number, number: string, extra: Partial<MangaDexChapter> = {}): MangaDexChapter => ({ id: uuid(id), number, title: "", language: "en", groupNames: ["Translation team"], url: "https://mangadex.org", readable: true, ...extra });
afterEach(() => vi.unstubAllGlobals());

describe("source discovery", () => {
  it("uses linked AniList IDs rather than identical titles or authors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [
      { id: uuid(1), attributes: { title: { en: "One-Punch Man" }, links: { al: "85364" } } },
      { id: uuid(2), attributes: { title: { en: "One Punch-Man" }, links: { al: "74347" } } },
      { id: uuid(3), attributes: { title: { en: "One-Punch Man (Fan Colored)" } } },
    ] })));
    const matches = await searchMangaDex("One-Punch Man", 74347);
    expect(matches.filter((c) => c.verified).map((c) => c.id)).toEqual([uuid(2)]);
  });
  it("never assigns Murata's official destination to ONE's webcomic", () => {
    expect(officialDestinations({ externalId: 74347 })[0]?.url).toContain("viz.com/shonenjump/chapters/one-punch-man");
    expect(officialDestinations({ externalId: 85364 })).toEqual([]);
    expect(officialDestinations({ externalId: 1 })).toEqual([]);
  });
  it("shows the verified Tapas reader only for the matching manhwa, not a novel or unrelated title", () => {
    const series = { externalId: 999999, title: "The Legendary Hero is an Academy Honors Student", type: "manhwa" as const };
    const links = officialDestinations(series);
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://tapas.io/series/the-legendary-hero-is-an-academy-honors-student/info");
    expect(links[0]?.note).toMatch(/unlocking/);
    expect(officialDestinations({ ...series, type: "manga" })).toEqual([]);
    expect(officialDestinations({ ...series, title: "Another Academy Hero" })).toEqual([]);
  });
  it("passes alternate titles to the server and rejects conflicting verified editions", async () => {
    const title = normalizeMedia({ id: 74347, title: { english: "One-Punch Man", romaji: "One Punch-Man" } }, "now")!;
    const fetcher = vi.fn(async (_url: string) => json({ status: "conflict", providerId: "mangadex", releases: [] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(mangaDexProvider.resolve(title)).rejects.toThrow("Multiple or conflicting editions");
    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toContain("One-Punch+Man");
    expect(url).toContain("One+Punch-Man");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("chapter lists", () => {
  it("paginates beyond 100 and retains attribution, external-only status and specials", async () => {
    const row = (n: number) => ({ id: uuid(n), attributes: { chapter: n === 0 ? null : String(n), pages: n === 1 ? 0 : 20, externalUrl: n === 1 ? "https://publisher.example/chapter" : null, translatedLanguage: "en" }, relationships: [{ type: "scanlation_group", attributes: { name: "Team" } }] });
    const fetcher = vi.fn().mockResolvedValueOnce(json({ data: Array.from({ length: 100 }, (_, n) => row(n)), total: 101 })).mockResolvedValueOnce(json({ data: [row(100)], total: 101 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await listMangaDexChapters(uuid(999));
    expect(result).toHaveLength(101);
    expect(fetcher.mock.calls[1]![0]).toContain("offset=100");
    expect(result[0]).toMatchObject({ number: "", groupNames: ["Team"], readable: true });
    expect(result[1]).toMatchObject({ readable: false, externalUrl: "https://publisher.example/chapter" });
  });
  it("does not silently return a partial list on a stalled page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], total: 200 })));
    await expect(listMangaDexChapters(uuid(1))).rejects.toThrow("pagination stopped");
  });
  it("sorts zero and decimals, preserves numberless specials and restarted volumes", () => {
    const result = selectChapters([chapter(1, "10"), chapter(2, "0"), chapter(3, "2.5"), chapter(4, "2"), chapter(5, ""), chapter(6, ""), chapter(7, "2", { volume: "2" })]);
    expect(result.slice(0, 4).map((c) => c.number)).toEqual(["0", "2", "2", "2.5"]);
    expect(result.filter((c) => c.number === "")).toHaveLength(2);
  });
  it("selects deterministic readable releases and preserves a saved translation", () => {
    const old = chapter(1, "1", { publishedAt: "2020" });
    const newer = chapter(2, "1.0", { publishedAt: "2026" });
    const external = chapter(3, "1", { readable: false, publishedAt: "2027" });
    expect(selectChapters([old, external, newer])[0]?.id).toBe(newer.id);
    expect(selectChapters([old, external, newer], [old.id])[0]?.id).toBe(old.id);
  });
  it("surfaces rate limits rather than treating them as an empty catalogue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(searchMangaDex("title", 1)).rejects.toThrow("busy");
  });
});

describe("saved translation preference regressions", () => {
  it.each([false, true])("keeps the older saved readable release regardless of feed ordering (reverse=%s)", (reverse) => {
    const saved = chapter(11, "12.5", { volume: "2", publishedAt: "2020-01-01", groupNames: ["Saved team"] });
    const newer = chapter(12, "12.50", { volume: "2", publishedAt: "2026-10-14", groupNames: ["New team"] });
    const otherVolume = chapter(13, "12.5", { volume: "3", publishedAt: "2026-10-14" });
    const feed = [saved, newer, otherVolume];
    const selected = selectChapters(reverse ? feed.reverse() : feed, [saved.id]);
    expect(selected.find((c) => c.volume === "2")).toEqual(saved);
    expect(selected.find((c) => c.volume === "3")).toEqual(otherVolume);
  });

  it.each([false, undefined])("prefers a readable duplicate over saved availability=%s", (readable) => {
    const saved = chapter(21, "3", { volume: "1", readable, publishedAt: "2026-10-14" });
    const available = chapter(22, "3.0", { volume: "1", readable: true, publishedAt: "2020-01-01" });
    for (const feed of [[saved, available], [available, saved]]) {
      expect(selectChapters(feed, [saved.id])).toEqual([available]);
    }
  });

  it("does not prioritize a saved external-only release over in-app pages", () => {
    const external = chapter(31, "1", { volume: "1", externalUrl: "https://publisher.example/read", publishedAt: "2026-10-14" });
    const available = chapter(32, "1", { volume: "1", publishedAt: "2020-01-01" });
    expect(selectChapters([external, available], [external.id])).toEqual([available]);
  });
});
