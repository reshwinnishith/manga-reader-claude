import type { SourceChapter } from "./reading-source-types";
import type { SavedTitle } from "@/domain/types";
import { listMangaDexChapters, searchMangaDex, selectChapters } from "./mangadex";

export interface OfficialDestination { label: string; url: string; note: string }
export interface SourceEdition {
  providerId: string;
  sourceId: string;
  title: string;
  chapters: SourceChapter[];
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
    // Search aliases only locate candidates. The source's AniList ID is the proof.
    for (const query of [...new Set([title.title, ...(title.alternateTitles || [])])].slice(0, 3)) {
      const candidates = await searchMangaDex(query, title.externalId, signal);
      const verified = candidates.filter((c) => c.verified);
      if (verified.length > 1) throw new Error("Multiple editions claim this identifier. Edition verification needs review.");
      const match = verified[0];
      if (match) return { providerId: "mangadex", sourceId: match.id, title: match.title, chapters: await listMangaDexChapters(match.id, signal) };
    }
    return null;
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
  const key = `${title.externalId}:${title.title}`;
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
