/**
 * Provider-neutral identity and rights policy for chapter sources.
 *
 * Pure functions only: the server routes and the client both use them, and
 * every rule here is unit-tested against recorded MangaDex responses.
 *
 * Identity: a source edition is the user's title only when a catalogue ID
 * matches exactly. AniList is preferred; MyAnimeList is accepted only when the
 * source has no AniList link at all (an AniList link that disagrees is a hard
 * conflict, even if MyAnimeList agrees). Titles and author names never prove
 * identity.
 *
 * Rights: MangaDex records an official English publication in `links.engtl`.
 * When one exists, this app conservatively withholds English uploads not
 * marked as official and offers the official destination instead. This is a
 * product access rule, NOT evidence that each withheld upload is unlawful;
 * catalogue links alone cannot establish individual upload permissions. Uploads without a
 * credited group are never readable: MangaDex's acceptable-use policy requires
 * crediting the group, and anonymous uploads include notices rather than
 * chapters. Official publisher groups (`official: true`) remain readable.
 */

export type VerifiedBy = "anilist" | "myanimelist";

export interface IdentityResult {
  verified: boolean;
  by?: VerifiedBy;
  /** The source links a different AniList entry. Never overridden. */
  conflict?: boolean;
}

export type SourceLinks = Record<string, string>;

export function verifyIdentity(links: SourceLinks, anilistId: number, malId?: number | null): IdentityResult {
  const al = links.al?.trim();
  if (al) return al === String(anilistId) ? { verified: true, by: "anilist" } : { verified: false, conflict: true };
  if (malId && Number.isSafeInteger(malId) && links.mal?.trim() === String(malId)) return { verified: true, by: "myanimelist" };
  return { verified: false };
}

export interface OfficialLink {
  label: string;
  url: string;
}

/** Only well-formed https URLs without credentials are ever turned into links. */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Official English publication recorded by the source catalogue, if any. */
export function officialEnglishLinks(links: SourceLinks): OfficialLink[] {
  const url = safeHttpsUrl(links.engtl);
  if (!url) return [];
  let host = "official site";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* validated above */
  }
  return [{ label: `Official English release (${host})`, url }];
}

export type Restriction = "licensed-in-english" | "uncredited" | "external" | "unavailable";

export interface ReleaseGroup {
  name: string;
  official: boolean;
}

export interface ReleaseRecord {
  id: string;
  number: string;
  volume: string;
  title: string;
  language: string;
  pages: number;
  externalUrl?: string;
  isUnavailable: boolean;
  publishedAt: string;
  groups: ReleaseGroup[];
}

export interface ReleaseAccess {
  readable: boolean;
  restriction?: Restriction;
}

export function classifyRelease(release: ReleaseRecord, context: { licensedInEnglish: boolean }): ReleaseAccess {
  if (release.externalUrl) return { readable: false, restriction: "external" };
  if (release.isUnavailable || !(release.pages > 0)) return { readable: false, restriction: "unavailable" };
  if (!release.groups.some((g) => g.name.trim())) return { readable: false, restriction: "uncredited" };
  if (context.licensedInEnglish && release.language === "en" && !release.groups.some((g) => g.official)) {
    return { readable: false, restriction: "licensed-in-english" };
  }
  return { readable: true };
}

// ---- Parsing raw MangaDex JSON (defensive: the API is external input) -----

type RecordLike = Record<string, unknown>;
const object = (value: unknown): RecordLike =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const MANGADEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MangaRecord {
  id: string;
  title: string;
  altTitles: string[];
  links: SourceLinks;
  originalLanguage: string;
  contentRating: string;
  creators: string[];
}

export function parseMangaRecord(raw: unknown): MangaRecord | null {
  const row = object(raw);
  const id = str(row.id);
  if (!MANGADEX_UUID.test(id)) return null;
  const attrs = object(row.attributes);
  const titles = object(attrs.title);
  const title = str(titles.en) || Object.values(titles).find((v): v is string => typeof v === "string") || "";
  if (!title) return null;
  const links: SourceLinks = {};
  for (const [key, value] of Object.entries(object(attrs.links))) {
    if (typeof value === "string" && value.trim()) links[key] = value.trim();
  }
  const altTitles = array(attrs.altTitles).flatMap((entry) => Object.values(object(entry)).filter((v): v is string => typeof v === "string"));
  const creators = [
    ...new Set(
      array(row.relationships)
        .map(object)
        .filter((r) => r.type === "author" || r.type === "artist")
        .map((r) => str(object(r.attributes).name))
        .filter(Boolean),
    ),
  ];
  return {
    id,
    title,
    altTitles,
    links,
    originalLanguage: str(attrs.originalLanguage),
    contentRating: str(attrs.contentRating),
    creators,
  };
}

export function parseReleaseRecord(raw: unknown): ReleaseRecord | null {
  const row = object(raw);
  const id = str(row.id);
  if (!MANGADEX_UUID.test(id)) return null;
  const attrs = object(row.attributes);
  const groups = array(row.relationships)
    .map(object)
    .filter((r) => r.type === "scanlation_group")
    .map((r) => {
      const a = object(r.attributes);
      return { name: str(a.name).trim(), official: a.official === true };
    })
    .filter((g) => g.name);
  const pages = Number(attrs.pages);
  return {
    id,
    number: str(attrs.chapter),
    volume: str(attrs.volume),
    title: str(attrs.title),
    language: str(attrs.translatedLanguage),
    pages: Number.isFinite(pages) ? pages : 0,
    externalUrl: safeHttpsUrl(attrs.externalUrl),
    isUnavailable: attrs.isUnavailable === true,
    publishedAt: str(attrs.publishAt),
    groups,
  };
}
