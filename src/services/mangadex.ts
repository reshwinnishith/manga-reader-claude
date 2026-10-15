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

/** Compatibility alias for the MangaDex transport. */
export type MangaDexChapter = import("./reading-source-types").SourceChapter;

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

/** Find a MangaDex title by name; only matching AniList IDs are used automatically. */
export async function searchMangaDex(title: string, anilistId: number, signal?: AbortSignal): Promise<MangaDexTitle[]> {
  const query = title.trim();
  if (query.length < 2) return [];
  const params = new URLSearchParams({ title: query });
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

const chapterCache = new Map<string, { expires: number; chapters: MangaDexChapter[] }>();

/** Fetch all available English chapter pages, bounded to avoid excessive API requests. */
export async function listMangaDexChapters(mangaId: string, signal?: AbortSignal): Promise<MangaDexChapter[]> {
  if (!UUID.test(mangaId)) throw new Error("Invalid MangaDex title.");
  const cached = chapterCache.get(mangaId);
  if (cached && cached.expires > Date.now()) return cached.chapters;
  const all: unknown[] = [];
  let complete = false;
  for (let offset = 0; offset <= 10000; offset += 100) {
    const payload = object(await getJson(`${API}?id=${encodeURIComponent(mangaId)}&offset=${offset}`, signal));
    const batch = array(payload.data);
    all.push(...batch);
    const total = Number(payload.total);
    if (Number.isFinite(total) && offset + batch.length >= total) { complete = true; break; }
    if (batch.length === 0) throw new Error("Chapter pagination stopped before all chapters were loaded.");
  }
  if (!complete) throw new Error("This edition exceeds the source pagination limit. Open MangaDex for the full list.");
  const chapters = all.flatMap((item) => {
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
      number: str(attrs.chapter),
      volume: str(attrs.volume),
      externalUrl: safeExternalUrl(attrs.externalUrl),
      readable: !attrs.externalUrl && attrs.isUnavailable !== true && Number(attrs.pages) > 0,
      publishedAt: str(attrs.publishAt),
      title: str(attrs.title),
      language: str(attrs.translatedLanguage),
      groupNames: groups,
      url: `https://mangadex.org/chapter/${id}`,
    }];
  });
  if (!signal?.aborted) {
    if (chapterCache.size >= 40) chapterCache.delete(chapterCache.keys().next().value!);
    chapterCache.set(mangaId, { expires: Date.now() + 120_000, chapters });
  }
  return chapters;
}

/** Do not turn arbitrary feed strings into executable or insecure links. */
function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

/** Stable release selection: readable pages first, then saved IDs, then newest publication and ID.
 * Numberless specials remain distinct; volume prevents merging restarted numbering.
 * Callers may supply saved chapter IDs so rereads retain the chosen translation.
 */
export function selectChapters(chapters: MangaDexChapter[], preferred: string[] = []): MangaDexChapter[] {
  const selected = new Map<string, MangaDexChapter>();
  const numeric = (value: string) => /^\d+(?:\.\d+)?$/.test(value);
  const saved = new Set(preferred);
  const readable = (c: MangaDexChapter) => c.readable === true && !c.externalUrl;
  // Availability outranks history. Within readable duplicates, history outranks
  // publication date in either feed order. Unknown availability is not readable.
  for (const c of [...chapters].sort((a, b) =>
    Number(readable(b)) - Number(readable(a)) ||
    Number(readable(b) && saved.has(b.id)) - Number(readable(a) && saved.has(a.id)) ||
    (b.publishedAt || "").localeCompare(a.publishedAt || "") || a.id.localeCompare(b.id))) {
    const key = numeric(c.number) ? `${c.volume || ""}:${Number(c.number)}` : c.id;
    if (!selected.has(key)) selected.set(key, c);
  }
  return [...selected.values()].sort((a, b) => {
    if (numeric(a.number) && numeric(b.number)) return Number(a.number) - Number(b.number) || (a.volume || "").localeCompare(b.volume || "", undefined, { numeric: true });
    if (numeric(a.number) !== numeric(b.number)) return numeric(a.number) ? -1 : 1;
    return (a.publishedAt || "").localeCompare(b.publishedAt || "") || a.id.localeCompare(b.id);
  });
}

/**
 * Previous/next for the in-app reader. Only chapters readable in-app take part:
 * external-only, withheld and unavailable releases are never navigation targets
 * (the title page still lists external ones as link-outs). Duplicate numbers are
 * collapsed by selectChapters, keeping the chapter being read, so navigation
 * never repeats a chapter or jumps to another group's copy of the same one.
 */
export function readerNeighbors(chapters: MangaDexChapter[], currentId: string): { previous?: MangaDexChapter; next?: MangaDexChapter } {
  const sequence = selectChapters(chapters.filter((c) => c.readable === true && !c.externalUrl), [currentId]);
  const index = sequence.findIndex((c) => c.id === currentId);
  if (index < 0) return {};
  return { previous: sequence[index - 1], next: sequence[index + 1] };
}
