import type { SourceChapter } from "./reading-source-types";
import type { SavedTitle } from "@/domain/types";
import { selectChapters } from "./mangadex";
import type { ResolvedEdition, ResolvedRelease } from "./mangadex-server";
import type { OfficialLink, Restriction, VerifiedBy } from "./source-policy";

export interface OfficialDestination { label: string; url: string; note: string }
export interface SourceEdition {
  providerId: string;
  sourceId: string;
  title: string;
  chapters: SourceChapter[];
  /** Which catalogue ID proved this is the user's edition. */
  verifiedBy?: VerifiedBy;
  /** The source records an official English publication; fan uploads are withheld. */
  licensedInEnglish?: boolean;
  officialLinks?: OfficialLink[];
  /** Releases withheld from in-app reading, by reason. */
  hidden?: Partial<Record<Restriction, number>>;
}

/** Browser → our route; one request per title, identity and rights decided server-side. */
async function getSourceJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, credentials: "same-origin", redirect: "error" });
  if (response.status === 429) throw new Error("The chapter source is busy. Please try again shortly.");
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("Chapter service returned a login page instead of chapter data.");
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(body?.error || `Chapter service returned HTTP ${response.status}.`);
  return body;
}

export function chaptersFromReleases(releases: ResolvedRelease[]): SourceChapter[] {
  return releases.map((r) => ({
    id: r.id,
    number: r.number,
    volume: r.volume,
    title: r.title,
    language: r.language,
    groupNames: r.groups,
    readable: r.readable,
    externalUrl: r.externalUrl,
    publishedAt: r.publishedAt,
    url: `https://mangadex.org/chapter/${r.id}`,
  }));
}

/** Classified releases of a known MangaDex edition (reader previous/next navigation). */
export async function editionChapters(mangaId: string, signal?: AbortSignal): Promise<SourceChapter[]> {
  const body = (await getSourceJson(`/api/sources/mangadex?${new URLSearchParams({ manga: mangaId })}`, signal)) as { releases?: ResolvedRelease[] };
  return chaptersFromReleases(Array.isArray(body.releases) ? body.releases : []);
}
/** A provider must resolve a verified edition before exposing chapters. New providers
 * must document permission, attribution and page transport; never guess an edition.
 */
export interface ReadingSourceProvider {
  id: string;
  label: string;
  documentation: string;
  chapterUrl(chapter: SourceChapter, seriesId: string): string;
  resolve(title: SavedTitle, signal?: AbortSignal): Promise<SourceEdition | null>;
}

export const mangaDexProvider: ReadingSourceProvider = {
  id: "mangadex", label: "MangaDex", documentation: "https://api.mangadex.org/docs/",
  chapterUrl: (chapter, seriesId) => readerUrl(chapter, seriesId),
  async resolve(title, signal) {
    // Titles only locate candidates; the server accepts a match by AniList ID,
    // or by MyAnimeList ID when the source has no AniList link at all.
    const params = new URLSearchParams({ al: String(title.externalId) });
    if (title.malId) params.set("mal", String(title.malId));
    for (const t of [...new Set([title.title, ...(title.alternateTitles || [])])].slice(0, 4)) params.append("t", t);
    const edition = (await getSourceJson(`/api/sources/mangadex?${params}`, signal)) as ResolvedEdition;
    if (edition.status === "conflict") throw new Error("Multiple or conflicting editions claim this identifier. Edition verification needs review.");
    if (edition.status !== "verified" || !edition.mangaId) return null;
    return {
      providerId: "mangadex",
      sourceId: edition.mangaId,
      title: edition.sourceTitle || title.title,
      chapters: chaptersFromReleases(edition.releases),
      verifiedBy: edition.verifiedBy,
      licensedInEnglish: edition.licensedInEnglish,
      officialLinks: edition.officialLinks,
      hidden: edition.hidden,
    };
  },
};

/** Publisher links are curated by catalogue ID, never generated from a title slug.
 * VIZ explicitly credits ONE and Yusuke Murata on this destination.
 */
export function officialDestinations(title: Pick<SavedTitle, "externalId"> & Partial<Pick<SavedTitle, "title" | "type">>): OfficialDestination[] {
  if (title.externalId === 74347) return [{
    label: "Read One-Punch Man on VIZ / Shonen Jump",
    url: "https://www.viz.com/shonenjump/chapters/one-punch-man",
    note: "Official ONE / Yusuke Murata edition. Availability varies by region; some chapters require a subscription.",
  }];

  // Curated publisher match for the specific English manhwa edition. Do not
  // match the similarly named prose novel or infer arbitrary publisher URLs.
  if (title.type === "manhwa" && title.title?.trim().toLocaleLowerCase("en") === "the legendary hero is an academy honors student") return [{
    label: "Read The Legendary Hero is an Academy Honors Student on Tapas",
    url: "https://tapas.io/series/the-legendary-hero-is-an-academy-honors-student/info",
    note: "Official English webtoon. Some episodes are free or Wait Until Free; others require unlocking on Tapas. Opens the publisher's reader.",
  }];
  return [];
}

export const readingProviders: readonly ReadingSourceProvider[] = [mangaDexProvider];
const cache = new Map<string, { expires: number; editions: SourceEdition[] }>();
export async function discoverReadingSources(title: SavedTitle, signal?: AbortSignal): Promise<SourceEdition[]> {
  const key = `${title.externalId}:${title.malId ?? ""}:${title.title}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.editions;
  const editions = (await Promise.all(readingProviders.map((p) => p.resolve(title, signal)))).filter((e): e is SourceEdition => e !== null);
  if (!signal?.aborted) {
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 120_000, editions });
  }
  return editions;
}

export function readerUrl(chapter: Pick<SourceChapter, "id" | "number">, seriesId: string): string {
  return `/mangadex/read/${chapter.id}?${new URLSearchParams({ series: seriesId, chapter: chapter.number })}`;
}

export function chapterSequence(edition: SourceEdition, preferred: string[] = []) {
  return selectChapters(edition.chapters, preferred);
}

/** The details UI delegates navigation to the provider rather than assuming a transport. */
export function sourceChapterUrl(providerId: string, chapter: SourceChapter, seriesId: string): string {
  const provider = readingProviders.find((p) => p.id === providerId);
  if (!provider) throw new Error("Unknown reading provider");
  return provider.chapterUrl(chapter, seriesId);
}
