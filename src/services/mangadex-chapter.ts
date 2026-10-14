import { MANGADEX_ID } from "./mangadex-pages";
import { anilistByMalId, getManga } from "./mangadex-server";
import { classifyRelease, officialEnglishLinks, parseReleaseRecord } from "./source-policy";

const RESTRICTION_MESSAGE = {
  "licensed-in-english": "This title has an official English release, so fan uploads aren't shown here. Use the official link on the title page.",
  uncredited: "This upload doesn't credit a translation group, so it isn't shown in MangaReader.",
  external: "This chapter is only available at its source.",
  unavailable: "This chapter's pages are unavailable.",
} as const;

/**
 * Resolve identity and reading rights from the source, never from reader query
 * parameters. The same rules as the chapter list apply, so a hidden release
 * cannot be opened by URL.
 */
export async function chapterIdentity(id: string, fetchImpl: typeof fetch = fetch) {
  if (!MANGADEX_ID.test(id)) throw new Error("Invalid chapter ID");
  const response = await fetchImpl(`https://api.mangadex.org/chapter/${id}?includes[]=scanlation_group`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(response.status === 404 ? "This chapter has been removed or is unavailable." : "Could not verify chapter identity.");
  const { data } = await response.json();
  const release = parseReleaseRecord(data);
  const mangaId = data?.relationships?.find((r: { type: string }) => r.type === "manga")?.id;
  if (!release || release.id !== id || !MANGADEX_ID.test(mangaId || "")) throw new Error("Could not verify chapter identity.");
  const manga = await getManga(mangaId, fetchImpl);
  const access = classifyRelease(release, { licensedInEnglish: officialEnglishLinks(manga.links).length > 0 });
  if (!access.readable) throw new Error(RESTRICTION_MESSAGE[access.restriction ?? "unavailable"]);

  let seriesId = "";
  const al = manga.links.al;
  if (al) {
    if (/^\d+$/.test(al)) seriesId = `al-${al}`;
  } else if (manga.links.mal && /^\d+$/.test(manga.links.mal)) {
    // Source links MyAnimeList only: map through AniList's own idMal field.
    const identity = await anilistByMalId(Number(manga.links.mal), fetchImpl).catch(() => null);
    if (identity) seriesId = `al-${identity.id}`;
  }
  return {
    mangaId: mangaId as string,
    seriesId,
    number: release.number,
    group: release.groups.map((g) => g.name).join(", "),
  };
}
