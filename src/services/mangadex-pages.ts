const API = "https://api.mangadex.org";
export const MANGADEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Manifest = { baseUrl: string; hash: string; files: string[]; fetched: number };
const cache = new Map<string, Manifest>();

export async function chapterManifest(id: string): Promise<Manifest> {
  if (!MANGADEX_ID.test(id)) throw new Error("Invalid chapter ID");
  const cached = cache.get(id);
  if (cached && Date.now() - cached.fetched < 10 * 60_000) return cached;
  const response = await fetch(`${API}/at-home/server/${id}?forcePort443=true`, { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 429 ? "MangaDex is busy. Try again later." : "Could not load chapter pages.");
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object") throw new Error("Invalid MangaDex response");
  const data = raw as { baseUrl?: unknown; chapter?: { hash?: unknown; dataSaver?: unknown } };
  if (typeof data.baseUrl !== "string" || typeof data.chapter?.hash !== "string" || !Array.isArray(data.chapter.dataSaver)) throw new Error("Invalid page information");
  const url = new URL(data.baseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".mangadex.network")) throw new Error("Untrusted image server");
  const files = data.chapter.dataSaver.filter((f): f is string => typeof f === "string" && /^[a-zA-Z0-9_.-]+$/.test(f));
  if (!files.length || files.length !== data.chapter.dataSaver.length || !/^[a-zA-Z0-9]+$/.test(data.chapter.hash)) throw new Error("Invalid page list");
  const manifest = { baseUrl: data.baseUrl.replace(/\/$/, ""), hash: data.chapter.hash, files, fetched: Date.now() };
  if (cache.size > 100) cache.clear();
  cache.set(id, manifest);
  return manifest;
}
