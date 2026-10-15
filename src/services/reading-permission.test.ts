import { afterEach, describe, expect, it, vi } from "vitest";
import { READING_PERMISSIONS, classifyRelease, isValidPermission, permissionsFor, type ReadingPermission, type ReleaseRecord } from "./source-policy";
import { assertChapterReadable, chapterIdentity } from "./mangadex-chapter";
import { summarizeReleases } from "./mangadex-server";
import { GET as pageRoute } from "@/app/api/mangadex/page/[id]/[index]/route";
import { GET as chapterRoute } from "@/app/api/mangadex/chapter/[id]/route";

const mangaId = "12345678-1234-4123-8123-123456789000";
const otherManga = "12345678-1234-4123-8123-123456789999";
const chapterId = "12345678-1234-4123-8123-123456789001";
const grant: ReadingPermission = { providerId: "mangadex", mangaId, basis: "publisher-license", evidenceUrl: "https://example.com/permission-record", reviewedBy: "test reviewer", reviewedAt: "2026-01-01" };
const manga = (links: Record<string, string> = {}) => ({ id: mangaId, title: "Example", altTitles: [], links, originalLanguage: "ja", contentRating: "safe", creators: [] });
const upload = (id: string, number: string, group: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  id, number, volume: "", title: "", language: "en", pages: 20, isUnavailable: false, publishedAt: "2026-01-01",
  groups: group ? [{ name: group, official: false }] : [], ...extra,
});
const ids = (n: number) => `12345678-1234-4123-8123-1234567890${String(n).padStart(2, "0")}`;

describe("reading permission registry", () => {
  it("ships empty: no source is verified as permitting in-app reading", () => {
    // Adding an entry must be a reviewed change that also updates this test (see docs/source-permissions.md).
    expect(READING_PERMISSIONS).toEqual([]);
  });

  it("only honours complete, current, https-evidenced entries for the exact edition", () => {
    const now = Date.parse("2026-06-01");
    expect(isValidPermission(grant, now)).toBe(true);
    for (const bad of [
      { ...grant, evidenceUrl: "" },
      { ...grant, evidenceUrl: "http://example.com/insecure" },
      { ...grant, evidenceUrl: "https://user:pw@example.com/x" },
      { ...grant, reviewedBy: " " },
      { ...grant, reviewedAt: "not a date" },
      { ...grant, reviewedAt: "2027-01-01" },
      { ...grant, expiresAt: "2026-02-01" },
      { ...grant, mangaId: "not-a-uuid" },
      { ...grant, groups: [] },
      { ...grant, basis: "popularity" as never },
    ]) expect(isValidPermission(bad, now)).toBe(false);
    expect(permissionsFor(mangaId, [grant], now)).toHaveLength(1);
    expect(permissionsFor(otherManga, [grant], now)).toEqual([]);
    expect(permissionsFor(mangaId, [{ ...grant, evidenceUrl: "" }], now)).toEqual([]);
  });
});

describe("default-deny classification", () => {
  it("withholds a title with missing licensing metadata (no official English link)", () => {
    // Yotsuba&!/Oshi no Ko shape: no `engtl`, credited fan groups, readable pages.
    const result = summarizeReleases(manga(), [upload(ids(1), "1", "Some scanlation team"), upload(ids(2), "2", "Another team")]);
    expect(result.licensedInEnglish).toBe(false);
    expect(result.releases).toEqual([]);
    expect(result.hidden).toEqual({ "not-permitted": 2 });
  });

  it("does not let any upload group, anonymous or named, establish permission", () => {
    for (const group of ["/a/nonymous", "Anonymous", "Jaimini's~box~", "Manga Reborn (Ex-License)", "Official Publisher"]) {
      const access = classifyRelease(upload(ids(1), "1", group, { groups: [{ name: group, official: group.startsWith("Official") }] }), { licensedInEnglish: false });
      expect(access, group).toEqual({ readable: false, restriction: "not-permitted" });
    }
  });

  it("does not treat official publisher chapters in the feed as permission for other uploads", () => {
    const feed = [
      upload(ids(1), "1", "MangaPlus", { pages: 0, externalUrl: "https://mangaplus.shueisha.co.jp/viewer/1", groups: [{ name: "MangaPlus", official: true }] }),
      upload(ids(2), "1", "Fan team"),
    ];
    const result = summarizeReleases(manga(), feed);
    expect(result.releases.filter((r) => r.readable)).toEqual([]);
    expect(result.releases.map((r) => r.id)).toEqual([ids(1)]); // the official link-out stays listed
    expect(result.releases[0]).toMatchObject({ readable: false, restriction: "external", externalUrl: "https://mangaplus.shueisha.co.jp/viewer/1" });
    expect(result.hidden).toEqual({ "not-permitted": 1 });
  });

  it("keeps official publisher links when the catalogue records them", () => {
    const result = summarizeReleases(manga({ engtl: "https://www.viz.com/series" }), [upload(ids(1), "1", "Fan team")]);
    expect(result.officialLinks).toEqual([{ label: "Official English release (viz.com)", url: "https://www.viz.com/series" }]);
    expect(result.hidden).toEqual({ "licensed-in-english": 1 });
  });

  it("scopes a grant to its edition, and to named groups when it names any", () => {
    const named: ReadingPermission = { ...grant, groups: ["Permitted team"] };
    const feed = [upload(ids(1), "1", "Permitted team"), upload(ids(2), "2", "Other team"), upload(ids(3), "3", "")];
    const result = summarizeReleases(manga(), feed, [named]);
    expect(result.releases.map((r) => [r.id, r.readable])).toEqual([[ids(1), true]]);
    expect(result.hidden).toEqual({ "not-permitted": 1, uncredited: 1 });
    expect(summarizeReleases({ ...manga(), id: otherManga }, feed, [named]).releases).toEqual([]);
  });

  it("applies grants only where the catalogue does not record an official English release or the upload is credited", () => {
    const licensed = summarizeReleases(manga({ engtl: "https://example.com/official" }), [upload(ids(1), "1", "Team")], [grant]);
    expect(licensed.releases).toEqual([]);
    expect(licensed.hidden).toEqual({ "licensed-in-english": 1 });
    expect(summarizeReleases(manga(), [upload(ids(2), "2", "")], [grant]).hidden).toEqual({ uncredited: 1 });
  });
});

describe("direct chapter access", () => {
  const stubSource = () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === `/chapter/${chapterId}`) return Response.json({ data: { id: chapterId, attributes: { chapter: "1", pages: 5, translatedLanguage: "en" }, relationships: [{ type: "manga", id: mangaId }, { type: "scanlation_group", attributes: { name: "Fan team" } }] } });
      if (url.pathname === `/manga/${mangaId}`) return Response.json({ data: { id: mangaId, attributes: { title: { en: "Example" }, links: { al: "1" } } } });
      if (url.pathname.startsWith("/at-home/")) return Response.json({ baseUrl: "https://uploads.mangadex.network", chapter: { hash: "abc", dataSaver: ["1.jpg"] } });
      return new Response("unexpected", { status: 500 });
    }));
    return { calls };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a disallowed chapter before any page manifest is requested", async () => {
    const { calls } = stubSource();
    await expect(chapterIdentity(chapterId)).rejects.toThrow("In-app reading isn't enabled");
    await expect(assertChapterReadable(chapterId)).rejects.toThrow("In-app reading isn't enabled");
    expect(calls.some((path) => path.startsWith("/at-home/"))).toBe(false);
  });

  it("allows the same chapter only with a grant for its edition", async () => {
    stubSource();
    await expect(chapterIdentity(chapterId, fetch, [grant])).resolves.toMatchObject({ number: "1", group: "Fan team", seriesId: "al-1" });
    await expect(chapterIdentity(chapterId, fetch, [{ ...grant, mangaId: otherManga }])).rejects.toThrow("isn't enabled");
  });

  it("chapter route returns an error and never asks for page data", async () => {
    const { calls } = stubSource();
    const response = await chapterRoute(new Request(`http://localhost/api/mangadex/chapter/${chapterId}`), { params: Promise.resolve({ id: chapterId }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: expect.stringContaining("isn't enabled") });
    expect(calls.some((path) => path.startsWith("/at-home/"))).toBe(false);
  });

  it("page route cannot be used to bypass the chapter check", async () => {
    const { calls } = stubSource();
    const response = await pageRoute(new Request(`http://localhost/api/mangadex/page/${chapterId}/0`), { params: Promise.resolve({ id: chapterId, index: "0" }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Page unavailable");
    expect(calls.some((path) => path.startsWith("/at-home/"))).toBe(false);
    expect(calls.some((path) => path.includes("mangadex.network"))).toBe(false);
  });
});
