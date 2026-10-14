import { describe, expect, it, vi } from "vitest";
import { FIXTURE_MANHWA, FIXTURE_MEDIA, jsonResponse, pageResponse } from "@/test/anilist-fixtures";
import {
  ANILIST_ENDPOINT, SearchError, createAniListClient, createRateLimiter, createSearchCache, normalizeMedia, typeFromCountry,
} from "./anilist";

const NOW = () => new Date("2026-10-14T12:00:00.000Z");

function clientWith(fetchImpl: typeof fetch, extra: Parameters<typeof createAniListClient>[0] = {}) {
  return createAniListClient({ fetchImpl, now: NOW, ...extra });
}
const ok = (media: unknown[] = [FIXTURE_MEDIA], hasNext = false) => vi.fn(async () => jsonResponse(pageResponse(media, hasNext)));

describe("normalizeMedia", () => {
  it("maps a record to a saved-title snapshot", () => {
    const t = normalizeMedia(FIXTURE_MEDIA, "2026-10-14T00:00:00Z")!;
    expect(t).toMatchObject({
      id: "al-101", source: "anilist", externalId: 101, title: "Moonlit Pharmacy (Fixture)", type: "manga",
      coverUrl: "https://example.test/covers/101.jpg", year: 2022, status: "ongoing", reportedChapters: 42,
      url: "https://anilist.co/manga/101", authors: ["Yuna Ashida"], fetchedAt: "2026-10-14T00:00:00Z",
    });
    expect(t.genres).toHaveLength(6); // capped
    expect(t.description).toBe("A pharmacist serves sleepless ghosts.\n\nBased on a fictional story & more.");
    expect(t.description).not.toContain("Secret twist"); // spoiler removed
  });

  it("falls back for sparse records (romaji title, no cover/description/url)", () => {
    const t = normalizeMedia(FIXTURE_MANHWA, "x")!;
    expect(t).toMatchObject({ id: "al-202", title: "Tap-eui Sigye", type: "manhwa", status: "completed", description: "" });
    expect(t.coverUrl).toBeUndefined();
    expect(t.year).toBeUndefined();
    expect(t.reportedChapters).toBeUndefined();
    expect(t.url).toBe("https://anilist.co/manga/202");
  });

  it("rejects unusable records and refuses non-https image/link URLs", () => {
    expect(normalizeMedia(null, "x")).toBeNull();
    expect(normalizeMedia({ id: "7", title: { romaji: "x" } }, "x")).toBeNull();
    expect(normalizeMedia({ id: 7, title: {} }, "x")).toBeNull();
    const t = normalizeMedia({ ...FIXTURE_MEDIA, coverImage: { large: "http://insecure/x.jpg" }, siteUrl: "javascript:alert(1)" }, "x")!;
    expect(t.coverUrl).toBeUndefined();
    expect(t.url).toBe("https://anilist.co/manga/101");
  });

  it("maps countries to types", () => {
    expect(typeFromCountry("JP")).toBe("manga");
    expect(typeFromCountry("KR")).toBe("manhwa");
    expect(typeFromCountry("CN")).toBe("manhua");
    expect(typeFromCountry("TW")).toBe("manhua");
    expect(typeFromCountry(undefined)).toBe("manga");
  });
});

describe("search request", () => {
  it("sends one POST with variables, excludes adult titles and novels, and sends no credentials or referrer", async () => {
    const fetchMock = ok();
    await clientWith(fetchMock).search({ query: "  moon   pharmacy ", country: "KR", page: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANILIST_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({ search: "moon pharmacy", page: 2, perPage: 20, country: "KR" });
    expect(body.query).toContain("isAdult: false");
    expect(body.query).toContain("format_not: NOVEL");
    expect(body.query).toContain("type: MANGA");
    expect(body.query).toContain("countryOfOrigin: $country");
  });

  it("omits the country filter for 'all'", async () => {
    const fetchMock = ok();
    await clientWith(fetchMock).search({ query: "moon" });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.variables).toEqual({ search: "moon", page: 1, perPage: 20 });
    expect(body.query).not.toContain("$country: CountryCode");
    expect(body.query).not.toContain("countryOfOrigin: $country");
    expect(body.query).toContain("countryOfOrigin\\n");
  });

  it("does not call the API for queries that are too short", async () => {
    const fetchMock = ok();
    expect(await clientWith(fetchMock).search({ query: " a " })).toEqual({ items: [], hasNextPage: false, page: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("search results", () => {
  it("returns normalised items, drops bad records and duplicates, and reports paging", async () => {
    const fetchMock = ok([FIXTURE_MEDIA, { nonsense: true }, FIXTURE_MEDIA, FIXTURE_MANHWA], true);
    const r = await clientWith(fetchMock).search({ query: "moon" });
    expect(r.items.map((i) => i.id)).toEqual(["al-101", "al-202"]);
    expect(r.hasNextPage).toBe(true);
  });

  it("returns an empty list for no matches", async () => {
    const r = await clientWith(ok([])).search({ query: "zzzzzz" });
    expect(r).toEqual({ items: [], hasNextPage: false, page: 1 });
  });

  it("serves repeat searches from the cache without another request", async () => {
    const fetchMock = ok();
    const c = clientWith(fetchMock);
    await c.search({ query: "Moon" });
    await c.search({ query: "  moon " });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await c.search({ query: "moon", country: "JP" }); // different filter = different request
    await c.search({ query: "moon", page: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("error handling", () => {
  const kind = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (e) {
      expect(e).toBeInstanceOf(SearchError);
      return e as SearchError;
    }
    throw new Error("expected a SearchError");
  };

  it("reports network failures as offline", async () => {
    const e = await kind(clientWith(vi.fn(async () => { throw new TypeError("Failed to fetch"); })).search({ query: "moon" }));
    expect(e.kind).toBe("offline");
  });

  it("reports aborts distinctly so the UI can ignore them", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    const e = await kind(clientWith(fetchMock).search({ query: "moon", signal: controller.signal }));
    expect(e.kind).toBe("aborted");
  });

  it("honours 429 + Retry-After and blocks further requests without calling the API", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "42" } }));
    const c = clientWith(fetchMock);
    const e1 = await kind(c.search({ query: "moon" }));
    expect(e1).toMatchObject({ kind: "rate-limited", retryAfter: 42 });
    const e2 = await kind(c.search({ query: "other" }));
    expect(e2.kind).toBe("rate-limited");
    expect(e2.retryAfter).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults the back-off to 60s when Retry-After is missing", async () => {
    const e = await kind(clientWith(vi.fn(async () => new Response("{}", { status: 429 }))).search({ query: "moon" }));
    expect(e.retryAfter).toBe(60);
  });

  it("reports 5xx as a server problem", async () => {
    const e = await kind(clientWith(vi.fn(async () => new Response("oops", { status: 503 }))).search({ query: "moon" }));
    expect(e.kind).toBe("server");
  });

  it.each([
    ["invalid JSON", () => new Response("<html>", { status: 200 })],
    ["GraphQL errors", () => jsonResponse({ errors: [{ message: "Bad" }], data: null }, { status: 400 })],
    ["wrong shape", () => jsonResponse({ data: { Page: { media: "nope" } } })],
  ])("reports %s as a bad response and does not cache it", async (_name, make) => {
    const fetchMock = vi.fn(async () => make());
    const c = clientWith(fetchMock);
    expect((await kind(c.search({ query: "moon" }))).kind).toBe("bad-response");
    await kind(c.search({ query: "moon" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits how many requests a tab can make per minute", async () => {
    let t = 0;
    const limiter = createRateLimiter(3, 60_000, () => t);
    const fetchMock = ok();
    const c = clientWith(fetchMock, { limiter, cache: createSearchCache(1, 1) });
    for (const q of ["aa", "bb", "cc"]) await c.search({ query: q });
    const e = await kind(c.search({ query: "dd" }));
    expect(e).toMatchObject({ kind: "rate-limited" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    t = 61_000;
    await c.search({ query: "dd" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("rate limiter and cache", () => {
  it("slides its window and supports explicit back-off", () => {
    let t = 0;
    const l = createRateLimiter(2, 1000, () => t);
    expect(l.take()).toBe(0);
    expect(l.take()).toBe(0);
    expect(l.take()).toBeGreaterThan(0);
    t = 1001;
    expect(l.take()).toBe(0);
    l.blockFor(30);
    expect(l.take()).toBe(30);
  });

  it("expires and bounds cache entries", () => {
    let t = 0;
    const cache = createSearchCache(1000, 2, () => t);
    const v = { items: [], hasNextPage: false, page: 1 };
    cache.set("a", v);
    cache.set("b", v);
    cache.set("c", v); // evicts a
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(v);
    t = 1500;
    expect(cache.get("b")).toBeUndefined();
  });
});
