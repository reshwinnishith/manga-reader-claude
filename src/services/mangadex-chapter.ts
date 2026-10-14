import { MANGADEX_ID } from "./mangadex-pages";

/** Resolve identity from the source, never from reader query parameters. */
export async function chapterIdentity(id: string) {
  if (!MANGADEX_ID.test(id)) throw new Error("Invalid chapter ID");
  const response = await fetch(`https://api.mangadex.org/chapter/${id}?includes[]=scanlation_group`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(response.status === 404 ? "This chapter has been removed or is unavailable." : "Could not verify chapter identity.");
  const { data } = await response.json();
  const mangaId = data?.relationships?.find((r: { type: string }) => r.type === "manga")?.id;
  if (!MANGADEX_ID.test(mangaId || "") || data.id !== id || data.attributes?.externalUrl || data.attributes?.isUnavailable) throw new Error("This chapter is only available at its source.");
  const mangaResponse = await fetch(`https://api.mangadex.org/manga/${mangaId}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!mangaResponse.ok) throw new Error("Could not verify the manga edition.");
  const manga = await mangaResponse.json();
  const al = String(manga.data?.attributes?.links?.al || "");
  return {
    mangaId: mangaId as string,
    seriesId: /^\d+$/.test(al) ? `al-${al}` : "",
    number: typeof data.attributes?.chapter === "string" ? data.attributes.chapter : "",
    group: (data.relationships || []).filter((r: { type: string }) => r.type === "scanlation_group").map((r: { attributes?: { name?: string } }) => r.attributes?.name).filter(Boolean).join(", ") || "Group not credited",
  };
}
