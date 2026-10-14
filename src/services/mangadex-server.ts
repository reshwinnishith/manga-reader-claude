/**
 * Server-side MangaDex resolution. Runs only in route handlers (Vercel), so the
 * browser makes one request per title instead of many, and identity/rights
 * checks happen where the reader re-verifies them too.
 *
 * MangaDex API: https://api.mangadex.org/docs/ (≈5 requests/second per IP,
 * credit MangaDex and translation groups, no ads/paid features).
 */
import {
  classifyRelease,
  officialEnglishLinks,
  parseMangaRecord,
  parseReleaseRecord,
  verifyIdentity,
  MANGADEX_UUID,
  type MangaRecord,
  type OfficialLink,
  type ReleaseRecord,
  type Restriction,
  type VerifiedBy,
} from "./source-policy";

const API = "https://api.mangadex.org";
const ANILIST = "https://graphql.anilist.co";
const TIMEOUT_MS = 12_000;
const FEED_PAGE = 500;
const MAX_FEED_OFFSET = 10_000;
const CACHE_MS = 2 * 60_000;

export class SourceError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "SourceError";
  }
}

type Fetch = typeof fetch;

/** Small bounded TTL cache; performance only, never offline storage. */
function ttlCache<T>(max = 100) {
  const map = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > CACHE_MS) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T) {
      map.delete(key);
      map.set(key, { at: Date.now(), value });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

async function getJson(fetchImpl: Fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    throw new SourceError("MangaDex could not be reached.");
  }
  if (response.status === 429) throw new SourceError("MangaDex is busy. Try again shortly.", 429);
  if (response.status === 404) throw new SourceError("Not found at MangaDex.", 404);
  if (!response.ok) throw new SourceError(`MangaDex returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new SourceError("MangaDex sent an unreadable response.");
  }
}

const data = (payload: unknown): unknown[] => {
  const d = (payload as { data?: unknown })?.data;
  return Array.isArray(d) ? d : [];
};

// ---- Catalogue lookups -------------------------------------------------------

const searchCache = ttlCache<MangaRecord[]>();

export async function searchMangaDex(query: string, fetchImpl: Fetch = fetch): Promise<MangaRecord[]> {
  const q = query.trim().replace(/\s+/g, " ");
  if (q.length < 2 || q.length > 150) return [];
  const hit = searchCache.get(q.toLowerCase());
  if (hit) return hit;
  const url = new URL(`${API}/manga`);
  url.searchParams.set("title", q);
  url.searchParams.set("limit", "50");
  for (const include of ["author", "artist"]) url.searchParams.append("includes[]", include);
  // AniList search already excludes adult titles; suggestive non-adult editions exist (e.g. OPM Murata).
  for (const rating of ["safe", "suggestive"]) url.searchParams.append("contentRating[]", rating);
  const records = data(await getJson(fetchImpl, url.href)).map(parseMangaRecord).filter((r): r is MangaRecord => r !== null);
  searchCache.set(q.toLowerCase(), records);
  return records;
}

const mangaCache = ttlCache<MangaRecord>();

export async function getManga(id: string, fetchImpl: Fetch = fetch): Promise<MangaRecord> {
  if (!MANGADEX_UUID.test(id)) throw new SourceError("Invalid MangaDex title.", 400);
  const hit = mangaCache.get(id);
  if (hit) return hit;
  const payload = await getJson(fetchImpl, `${API}/manga/${id}?includes[]=author&includes[]=artist`);
  const record = parseMangaRecord((payload as { data?: unknown })?.data);
  if (!record) throw new SourceError("MangaDex returned an invalid title.");
  mangaCache.set(id, record);
  return record;
}

const feedCache = ttlCache<ReleaseRecord[]>(60);

/** Every English release, paginated to the reported total. Partial lists raise errors. */
export async function getEnglishFeed(mangaId: string, fetchImpl: Fetch = fetch): Promise<ReleaseRecord[]> {
  if (!MANGADEX_UUID.test(mangaId)) throw new SourceError("Invalid MangaDex title.", 400);
  const hit = feedCache.get(mangaId);
  if (hit) return hit;
  const releases: ReleaseRecord[] = [];
  for (let offset = 0; ; offset += FEED_PAGE) {
    if (offset > MAX_FEED_OFFSET) throw new SourceError("This edition exceeds the source pagination limit.");
    const url = new URL(`${API}/manga/${mangaId}/feed`);
    url.searchParams.set("limit", String(FEED_PAGE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.append("translatedLanguage[]", "en");
    url.searchParams.append("includes[]", "scanlation_group");
    url.searchParams.set("order[chapter]", "asc");
    for (const rating of ["safe", "suggestive", "erotica"]) url.searchParams.append("contentRating[]", rating);
    const payload = await getJson(fetchImpl, url.href);
    const batch = data(payload);
    for (const item of batch) {
      const release = parseReleaseRecord(item);
      if (release) releases.push(release);
    }
    const total = Number((payload as { total?: unknown })?.total);
    if (!Number.isFinite(total)) throw new SourceError("MangaDex did not report a chapter total.");
    if (offset + batch.length >= total) break;
    if (batch.length === 0) throw new SourceError("Chapter pagination stopped before all chapters were loaded.");
  }
  feedCache.set(mangaId, releases);
  return releases;
}

// ---- AniList (identity only) ----------------------------------------------------

export interface AniListIdentity {
  id: number;
  malId: number | null;
  titles: string[];
  title: string;
  format: string;
  country: string;
}

const anilistCache = ttlCache<AniListIdentity | null>();

const IDENTITY_FIELDS = "id idMal format countryOfOrigin isAdult title { english romaji native } synonyms";

async function anilistQuery(query: string, variables: Record<string, unknown>, fetchImpl: Fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SourceError("AniList could not be reached.");
  }
  if (response.status === 429) throw new SourceError("AniList is busy. Try again shortly.", 429);
  const body = (await response.json().catch(() => null)) as { data?: unknown; errors?: { status?: number }[] } | null;
  if (body?.errors?.some((e) => e.status === 404)) return null;
  if (!response.ok || !body) throw new SourceError(`AniList returned HTTP ${response.status}.`);
  return body.data;
}

function toIdentity(media: unknown): AniListIdentity | null {
  const m = media as {
    id?: unknown; idMal?: unknown; format?: unknown; countryOfOrigin?: unknown; isAdult?: unknown;
    title?: { english?: unknown; romaji?: unknown; native?: unknown }; synonyms?: unknown;
  } | null;
  if (!m || typeof m.id !== "number" || m.isAdult === true) return null;
  const titles = [m.title?.english, m.title?.romaji, m.title?.native, ...(Array.isArray(m.synonyms) ? m.synonyms : [])]
    .filter((t): t is string => typeof t === "string" && t.trim().length > 1)
    .map((t) => t.trim());
  return {
    id: m.id,
    malId: typeof m.idMal === "number" ? m.idMal : null,
    titles: [...new Set(titles)],
    title: titles[0] ?? "",
    format: typeof m.format === "string" ? m.format : "",
    country: typeof m.countryOfOrigin === "string" ? m.countryOfOrigin : "",
  };
}

export async function anilistById(id: number, fetchImpl: Fetch = fetch): Promise<AniListIdentity | null> {
  const key = `id:${id}`;
  const hit = anilistCache.get(key);
  if (hit !== undefined) return hit;
  const result = toIdentity(((await anilistQuery(`query ($id: Int) { Media(id: $id, type: MANGA) { ${IDENTITY_FIELDS} } }`, { id }, fetchImpl)) as { Media?: unknown } | null)?.Media);
  anilistCache.set(key, result);
  return result;
}

/** MyAnimeList → AniList, used when a source links only MyAnimeList. */
export async function anilistByMalId(malId: number, fetchImpl: Fetch = fetch): Promise<AniListIdentity | null> {
  const key = `mal:${malId}`;
  const hit = anilistCache.get(key);
  if (hit !== undefined) return hit;
  const result = toIdentity(((await anilistQuery(`query ($id: Int) { Media(idMal: $id, type: MANGA) { ${IDENTITY_FIELDS} } }`, { id: malId }, fetchImpl)) as { Media?: unknown } | null)?.Media);
  anilistCache.set(key, result);
  return result;
}

/** First non-adult, non-novel AniList match for a search (coverage audit only). */
export async function anilistSearch(search: string, fetchImpl: Fetch = fetch): Promise<AniListIdentity | null> {
  const payload = (await anilistQuery(
    `query ($search: String) { Page(perPage: 5) { media(search: $search, type: MANGA, isAdult: false, format_not: NOVEL, sort: SEARCH_MATCH) { ${IDENTITY_FIELDS} } } }`,
    { search },
    fetchImpl,
  )) as { Page?: { media?: unknown[] } } | null;
  return toIdentity(payload?.Page?.media?.[0]);
}

// ---- Resolution ------------------------------------------------------------------

export interface ResolvedRelease {
  id: string;
  number: string;
  volume: string;
  title: string;
  language: string;
  pages: number;
  groups: string[];
  publishedAt: string;
  externalUrl?: string;
  readable: boolean;
  restriction?: Restriction;
}

export interface ResolvedEdition {
  status: "verified" | "not-found" | "conflict";
  providerId: "mangadex";
  verifiedBy?: VerifiedBy;
  mangaId?: string;
  sourceTitle?: string;
  creators?: string[];
  officialLinks: OfficialLink[];
  licensedInEnglish: boolean;
  releases: ResolvedRelease[];
  hidden: Partial<Record<Restriction, number>>;
  checkedAt: string;
}

export function summarizeReleases(manga: MangaRecord, feed: ReleaseRecord[]): Pick<ResolvedEdition, "officialLinks" | "licensedInEnglish" | "releases" | "hidden"> {
  const officialLinks = officialEnglishLinks(manga.links);
  const licensedInEnglish = officialLinks.length > 0;
  const hidden: Partial<Record<Restriction, number>> = {};
  const releases: ResolvedRelease[] = [];
  for (const r of feed) {
    const access = classifyRelease(r, { licensedInEnglish });
    // Restricted releases are counted, not listed: never show fan uploads of a
    // licensed edition or uncredited "notice" uploads as chapters.
    if (!access.readable && access.restriction !== "external" && access.restriction !== "unavailable") {
      hidden[access.restriction!] = (hidden[access.restriction!] ?? 0) + 1;
      continue;
    }
    releases.push({
      id: r.id,
      number: r.number,
      volume: r.volume,
      title: r.title,
      language: r.language,
      pages: r.pages,
      groups: r.groups.map((g) => g.name),
      publishedAt: r.publishedAt,
      externalUrl: r.externalUrl,
      readable: access.readable,
      restriction: access.restriction,
    });
  }
  return { officialLinks, licensedInEnglish, releases, hidden };
}

export interface ResolveInput {
  anilistId: number;
  malId?: number | null;
  titles: string[];
}

const resolveCache = ttlCache<ResolvedEdition>(60);

/** Find the exact edition by catalogue ID, then classify every English release. */
export async function resolveEdition(input: ResolveInput, fetchImpl: Fetch = fetch): Promise<ResolvedEdition> {
  const titles = [...new Set(input.titles.map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 4);
  const key = `${input.anilistId}:${input.malId ?? ""}:${titles.join("|")}`;
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const base = { providerId: "mangadex" as const, officialLinks: [], licensedInEnglish: false, releases: [], hidden: {}, checkedAt: new Date().toISOString() };

  let match: MangaRecord | undefined;
  let verifiedBy: VerifiedBy | undefined;
  let conflict = false;
  for (const title of titles) {
    const candidates = await searchMangaDex(title, fetchImpl);
    const verified = candidates
      .map((c) => ({ c, v: verifyIdentity(c.links, input.anilistId, input.malId) }))
      .filter((x) => x.v.verified);
    const unique = [...new Map(verified.map((x) => [x.c.id, x])).values()];
    if (unique.length > 1) {
      const result: ResolvedEdition = { ...base, status: "conflict" };
      resolveCache.set(key, result);
      return result;
    }
    if (unique[0]) {
      match = unique[0].c;
      verifiedBy = unique[0].v.by;
      break;
    }
    conflict ||= candidates.some((c) => verifyIdentity(c.links, input.anilistId, input.malId).conflict && c.links.mal === String(input.malId ?? ""));
  }
  if (!match) {
    // A MyAnimeList match whose AniList link points elsewhere is a conflict, not a match.
    const result: ResolvedEdition = { ...base, status: conflict ? "conflict" : "not-found" };
    resolveCache.set(key, result);
    return result;
  }
  const feed = await getEnglishFeed(match.id, fetchImpl);
  const result: ResolvedEdition = {
    ...base,
    status: "verified",
    verifiedBy,
    mangaId: match.id,
    sourceTitle: match.title,
    creators: match.creators,
    ...summarizeReleases(match, feed),
  };
  resolveCache.set(key, result);
  return result;
}

/** Chapters for a known MangaDex edition (reader navigation), with the same rights rules. */
export async function editionReleases(mangaId: string, fetchImpl: Fetch = fetch) {
  const [manga, feed] = await Promise.all([getManga(mangaId, fetchImpl), getEnglishFeed(mangaId, fetchImpl)]);
  return { mangaId, sourceTitle: manga.title, ...summarizeReleases(manga, feed) };
}
