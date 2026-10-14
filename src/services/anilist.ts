import type { PublicationStatus, SavedTitle, SeriesType } from "@/domain/types";
import { cleanDescription } from "@/lib/clean-description";

/**
 * Title search against AniList's public GraphQL API (https://anilist.gitbook.io/anilist-apiv2-docs).
 *
 * Scope: metadata only (title, cover, description, genres...). No chapters, no
 * images of pages, no account access.
 *
 * Good-citizen rules enforced here:
 *  - one request per user-initiated search (the UI debounces typing)
 *  - a client-side limiter well below AniList's 90 requests/minute
 *  - a short in-memory cache so repeats cost nothing
 *  - 429 / Retry-After is honoured; no automatic retry loops
 *  - adult-flagged titles and novels are excluded in the query itself
 */

export const ANILIST_ENDPOINT = "https://graphql.anilist.co";
export const ANILIST_SITE = "https://anilist.co";
export const PAGE_SIZE = 20;
export const MIN_QUERY_LENGTH = 2;

export type CountryFilter = "all" | "JP" | "KR" | "CN";

export type SearchErrorKind = "offline" | "rate-limited" | "server" | "bad-response" | "aborted";

export class SearchError extends Error {
  constructor(
    readonly kind: SearchErrorKind,
    message: string,
    /** Seconds to wait before trying again (rate limiting). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export interface SearchResult {
  items: SavedTitle[];
  hasNextPage: boolean;
  page: number;
}

const SEARCH_QUERY = /* GraphQL */ `
  query ($search: String, $page: Int, $perPage: Int, $country: CountryCode) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        hasNextPage
        currentPage
      }
      media(
        search: $search
        type: MANGA
        format_not: NOVEL
        isAdult: false
        countryOfOrigin: $country
        sort: SEARCH_MATCH
      ) {
        id
        title {
          romaji
          english
        }
        description(asHtml: false)
        coverImage {
          large
        }
        format
        status
        chapters
        genres
        startDate {
          year
        }
        countryOfOrigin
        siteUrl
        staff(perPage: 3, sort: RELEVANCE) {
          edges {
            role
            node {
              name {
                full
              }
            }
          }
        }
      }
    }
  }
`;

// AniList's optional country filter is omitted entirely for All searches.
// This avoids passing a null country condition to the live API.
const ALL_COUNTRIES_QUERY = SEARCH_QUERY
  .replace(", $country: CountryCode", "")
  .replace("        countryOfOrigin: $country\n", "");

// ---- Rate limiting ---------------------------------------------------------

export interface RateLimiter {
  /** Seconds until another request is allowed (0 = go ahead). Records the request when allowed. */
  take(): number;
  /** Block everything for `seconds` (server told us to back off). */
  blockFor(seconds: number): void;
}

/** Sliding-window limiter. Defaults sit far under AniList's 90/min (and its temporary 30/min). */
export function createRateLimiter(max = 20, windowMs = 60_000, now: () => number = Date.now): RateLimiter {
  const stamps: number[] = [];
  let blockedUntil = 0;
  return {
    take() {
      const t = now();
      if (t < blockedUntil) return Math.ceil((blockedUntil - t) / 1000);
      while (stamps.length && t - stamps[0]! >= windowMs) stamps.shift();
      if (stamps.length >= max) return Math.max(1, Math.ceil((windowMs - (t - stamps[0]!)) / 1000));
      stamps.push(t);
      return 0;
    },
    blockFor(seconds) {
      blockedUntil = now() + seconds * 1000;
    },
  };
}

// ---- Cache -----------------------------------------------------------------

export interface SearchCache {
  get(key: string): SearchResult | undefined;
  set(key: string, value: SearchResult): void;
}

export function createSearchCache(ttlMs = 10 * 60_000, maxEntries = 50, now: () => number = Date.now): SearchCache {
  const entries = new Map<string, { at: number; value: SearchResult }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
  };
}

// ---- Normalising -----------------------------------------------------------

const STATUS: Record<string, PublicationStatus> = {
  FINISHED: "completed",
  RELEASING: "ongoing",
  HIATUS: "hiatus",
  CANCELLED: "cancelled",
  NOT_YET_RELEASED: "upcoming",
};

export function typeFromCountry(country: string | null | undefined): SeriesType {
  if (country === "KR") return "manhwa";
  if (country === "CN" || country === "TW" || country === "HK") return "manhua";
  return "manga";
}

interface RawMedia {
  id?: unknown;
  title?: { romaji?: string | null; english?: string | null } | null;
  description?: string | null;
  coverImage?: { large?: string | null } | null;
  status?: string | null;
  chapters?: number | null;
  genres?: unknown;
  startDate?: { year?: number | null } | null;
  countryOfOrigin?: string | null;
  siteUrl?: string | null;
  staff?: { edges?: { role?: string | null; node?: { name?: { full?: string | null } | null } | null }[] | null } | null;
}

const isHttps = (v: unknown): v is string => typeof v === "string" && /^https:\/\//.test(v);

/** Validate one API record and map it to our model. Returns null if it is unusable. */
export function normalizeMedia(raw: unknown, fetchedAt: string): SavedTitle | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RawMedia;
  if (typeof m.id !== "number" || !Number.isInteger(m.id)) return null;
  const title = (m.title?.english || m.title?.romaji || "").trim();
  if (!title) return null;

  const authors: string[] = [];
  for (const edge of m.staff?.edges ?? []) {
    const name = edge?.node?.name?.full?.trim();
    if (name && !authors.includes(name)) authors.push(name);
  }

  const id = m.id;
  return {
    id: `al-${id}`,
    source: "anilist",
    externalId: id,
    title,
    type: typeFromCountry(m.countryOfOrigin),
    description: cleanDescription(m.description),
    coverUrl: isHttps(m.coverImage?.large) ? m.coverImage!.large! : undefined,
    genres: Array.isArray(m.genres) ? m.genres.filter((g): g is string => typeof g === "string").slice(0, 6) : [],
    authors: authors.slice(0, 3),
    year: typeof m.startDate?.year === "number" ? m.startDate.year : undefined,
    status: STATUS[m.status ?? ""] ?? "ongoing",
    reportedChapters: typeof m.chapters === "number" && m.chapters > 0 ? m.chapters : undefined,
    url: isHttps(m.siteUrl) ? m.siteUrl : `${ANILIST_SITE}/manga/${id}`,
    fetchedAt,
  };
}

// ---- Client ----------------------------------------------------------------

export interface SearchOptions {
  query: string;
  country?: CountryFilter;
  page?: number;
  signal?: AbortSignal;
}

export interface AniListClientDeps {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  cache?: SearchCache;
  now?: () => Date;
}

export interface AniListClient {
  search(options: SearchOptions): Promise<SearchResult>;
}

export function createAniListClient(deps: AniListClientDeps = {}): AniListClient {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const limiter = deps.limiter ?? createRateLimiter();
  const cache = deps.cache ?? createSearchCache();
  const now = deps.now ?? (() => new Date());

  return {
    async search({ query, country = "all", page = 1, signal }) {
      const search = query.trim().replace(/\s+/g, " ");
      if (search.length < MIN_QUERY_LENGTH) return { items: [], hasNextPage: false, page };

      const key = `${country}|${page}|${search.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const wait = limiter.take();
      if (wait > 0) {
        throw new SearchError("rate-limited", `Too many searches. Try again in ${wait}s.`, wait);
      }

      let response: Response;
      try {
        response = await fetchImpl(ANILIST_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            query: country === "all" ? ALL_COUNTRIES_QUERY : SEARCH_QUERY,
            variables: country === "all"
              ? { search, page, perPage: PAGE_SIZE }
              : { search, page, perPage: PAGE_SIZE, country },
          }),
          signal,
          referrerPolicy: "no-referrer",
          credentials: "omit",
        });
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw new SearchError("aborted", "Search cancelled");
        }
        throw new SearchError("offline", "Couldn't reach AniList. Check your connection and try again.");
      }

      if (response.status === 429) {
        const header = Number(response.headers.get("Retry-After"));
        const seconds = Number.isFinite(header) && header > 0 ? Math.ceil(header) : 60;
        limiter.blockFor(seconds);
        throw new SearchError("rate-limited", `AniList asked us to slow down. Try again in ${seconds}s.`, seconds);
      }
      if (response.status >= 500) {
        throw new SearchError("server", "AniList is having trouble right now. Try again in a moment.");
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SearchError("bad-response", "AniList sent a response we couldn't read.");
      }
      const data = body as { data?: { Page?: { pageInfo?: { hasNextPage?: boolean }; media?: unknown } } | null; errors?: unknown };
      const media = data?.data?.Page?.media;
      if (!response.ok || data?.errors || !Array.isArray(media)) {
        throw new SearchError("bad-response", "AniList sent an unexpected response. Please try again later.");
      }

      const fetchedAt = now().toISOString();
      const seen = new Set<string>();
      const items: SavedTitle[] = [];
      for (const raw of media) {
        const item = normalizeMedia(raw, fetchedAt);
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
      const result: SearchResult = { items, hasNextPage: data.data?.Page?.pageInfo?.hasNextPage === true, page };
      cache.set(key, result);
      return result;
    },
  };
}

/** Shared client for the running app (one limiter + cache per browser tab). */
let appClient: AniListClient | undefined;
export function getAniListClient(): AniListClient {
  appClient ??= createAniListClient();
  return appClient;
}
