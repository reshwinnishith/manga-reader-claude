/**
 * MangaDex chapter discovery. Metadata only: page images are not fetched here.
 * Public API: https://api.mangadex.org/docs
 * Keep MangaDex and scanlation group credits visible when adding a reader.
 */
const API = "/api/mangadex/discover";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MangaDexTitle {
  id: string;
  title: string;
  verified: boolean;
  category: string;
  authors: string[];
  coverUrl?: string;
}

export interface MangaDexChapter {
  id: string;
  number: string;
  title: string;
  language: string;
  groupNames: string[];
  url: string;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  // Preserve preview authentication cookies for our own API.
  const response = await fetch(url, { signal, credentials: "same-origin", redirect: "error" });
  if (response.status === 429) throw new Error("MangaDex is busy. Please try again later.");
  if (!response.ok) throw new Error(`Chapter service returned HTTP ${response.status}.`);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("Chapter service returned a login page instead of chapter data.");
  return response.json();
}

type RecordLike = Record<string, unknown>;
const object = (value: unknown): RecordLike =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** Find a MangaDex title by name; the user must confirm the match. */
export async function searchMangaDex(title: string, anilistId: number, signal?: AbortSignal): Promise<MangaDexTitle[]> {
  const query = title.trim();
  if (query.length < 2) return [];
  const params = new URLSearchParams({ title: query, limit: "100", "contentRating[]": "safe" });
  const payload = object(await getJson(`${API}?${params}`, signal));
  return array(payload.data).flatMap((item) => {
    const row = object(item);
    const id = str(row.id);
    const attrs = object(row.attributes);
    const titles = object(attrs.title);
    const display = str(titles.en) || Object.values(titles).find((v): v is string => typeof v === "string") || "";
    const verified = String(object(attrs.links).al || "") === String(anilistId);
    const category = /doujinshi|fan.colou?red|fancomic|crossover| x | × /i.test(display) ? "Fan work / alternate edition" : /webcomic/i.test(display) ? "Original webcomic" : "Unverified edition";
    const relations = array(row.relationships).map(object);
    const authors = relations.filter((r) => r.type === "author" || r.type === "artist").map((r) => str(object(r.attributes).name)).filter(Boolean);
    const cover = relations.find((r) => r.type === "cover_art");
    const filename = str(object(cover ? cover.attributes : null).fileName);
    const coverUrl = filename && UUID.test(id) ? `https://uploads.mangadex.org/covers/${id}/${encodeURIComponent(filename)}.256.jpg` : undefined;
    return UUID.test(id) && display ? [{ id, title: display, verified, category: verified ? "Verified AniList match" : category, authors: [...new Set(authors)], coverUrl }] : [];
  }).sort((a, b) => Number(b.verified) - Number(a.verified));
}

/** English chapters only for the first checkpoint, newest first, up to 100. */
export async function listMangaDexChapters(mangaId: string, signal?: AbortSignal): Promise<MangaDexChapter[]> {
  if (!UUID.test(mangaId)) throw new Error("Invalid MangaDex title.");
  const params = new URLSearchParams({ limit: "100", offset: "0", "translatedLanguage[]": "en", "order[chapter]": "desc", "includes[]": "scanlation_group" });
  const payload = object(await getJson(`${API}?id=${encodeURIComponent(mangaId)}`, signal));
  return array(payload.data).flatMap((item) => {
    const row = object(item);
    const id = str(row.id);
    if (!UUID.test(id)) return [];
    const attrs = object(row.attributes);
    const groups = array(row.relationships)
      .map(object)
      .filter((relation) => relation.type === "scanlation_group")
      .map((relation) => str(object(relation.attributes).name))
      .filter(Boolean);
    return [{
      id,
      number: str(attrs.chapter) || "?",
      title: str(attrs.title),
      language: str(attrs.translatedLanguage),
      groupNames: groups,
      url: `https://mangadex.org/chapter/${id}`,
    }];
  });
}
