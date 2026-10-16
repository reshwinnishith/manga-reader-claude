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
 * Rights: in-app page access is DENIED BY DEFAULT. A release is readable only
 * when a reviewed entry in READING_PERMISSIONS affirmatively covers its edition
 * (and, if the entry names groups, its group). Nothing else grants access:
 * missing licensing metadata, a MangaDex upload group (named, "official" or
 * anonymous), an image endpoint that happens to respond, or official publisher
 * chapters appearing in the same feed are NOT evidence of permission. See
 * docs/source-permissions.md. Official publisher links are always preserved.
 *
 * Restrictions that apply even when a permission exists: external-only or
 * unavailable releases, uploads with no credited group (attribution is a
 * condition of use, never a grant), and English fan uploads of an edition the
 * catalogue records as officially licensed in English (`links.engtl`).
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

export type Restriction = "licensed-in-english" | "uncredited" | "external" | "unavailable" | "not-permitted";

export type PermissionBasis = "publisher-license" | "rights-holder-consent" | "public-domain";

/**
 * A reviewed grant for in-app page access. Entries are data, added only after a
 * human has documented permission compatible with MangaReader's use (personal,
 * non-commercial, no offline copies). `evidenceUrl` must point at that record.
 */
export interface ReadingPermission {
  providerId: "mangadex";
  /** The exact source edition this grant covers. */
  mangaId: string;
  /** Optional: restrict the grant to these credited groups (case-insensitive). */
  groups?: readonly string[];
  basis: PermissionBasis;
  evidenceUrl: string;
  reviewedBy: string;
  /** ISO date of the review. */
  reviewedAt: string;
  /** ISO date after which the grant no longer applies. */
  expiresAt?: string;
}

/**
 * Reviewed grants for editions affirmatively verified as permitting in-app reading.
 * Do not add an entry because a chapter endpoint returns images; see
 * docs/source-permissions.md for what an entry requires.
 */
export const READING_PERMISSIONS: readonly ReadingPermission[] = [
  {
    providerId: "mangadex",
    mangaId: "9fca3c19-ac41-4ebf-8735-f4e3becc2b3e",
    groups: ["Manga Reborn (Ex-License)"],
    basis: "rights-holder-consent",
    evidenceUrl: "https://densho810.com/free/",
    reviewedBy: "MangaReader Rights Review",
    reviewedAt: "2026-10-16",
  },
];

/** An entry that is missing evidence or review details never grants anything. */
export function isValidPermission(entry: ReadingPermission, now = Date.now()): boolean {
  if (entry.providerId !== "mangadex" || !MANGADEX_UUID.test(entry.mangaId)) return false;
  if (!["publisher-license", "rights-holder-consent", "public-domain"].includes(entry.basis)) return false;
  if (!safeHttpsUrl(entry.evidenceUrl) || !entry.reviewedBy?.trim()) return false;
  const reviewed = Date.parse(entry.reviewedAt);
  if (!Number.isFinite(reviewed) || reviewed > now) return false;
  if (entry.expiresAt !== undefined) {
    const expires = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return false;
  }
  if (entry.groups !== undefined && (entry.groups.length === 0 || entry.groups.some((g) => !g.trim()))) return false;
  return true;
}

/** Every valid grant for this edition (a release is checked against each). */
export function permissionsFor(mangaId: string, registry: readonly ReadingPermission[] = READING_PERMISSIONS, now = Date.now()): ReadingPermission[] {
  return registry.filter((entry) => entry.mangaId.toLowerCase() === mangaId.toLowerCase() && isValidPermission(entry, now));
}

function permits(grants: readonly ReadingPermission[], release: ReleaseRecord): boolean {
  return grants.some((grant) => {
    if (!grant.groups) return true;
    const allowed = grant.groups.map((g) => g.trim().toLowerCase());
    return release.groups.some((g) => allowed.includes(g.name.trim().toLowerCase()));
  });
}

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

export function classifyRelease(release: ReleaseRecord, context: { licensedInEnglish: boolean; grants?: readonly ReadingPermission[] }): ReleaseAccess {
  if (release.externalUrl) return { readable: false, restriction: "external" };
  if (release.isUnavailable || !(release.pages > 0)) return { readable: false, restriction: "unavailable" };
  if (!release.groups.some((g) => g.name.trim())) return { readable: false, restriction: "uncredited" };
  if (context.licensedInEnglish && release.language === "en") {
    return { readable: false, restriction: "licensed-in-english" };
  }
  // Default deny: only an affirmative, reviewed grant for this edition (and
  // group, if the grant names any) makes a release readable in-app.
  if (!permits(context.grants ?? [], release)) return { readable: false, restriction: "not-permitted" };
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
