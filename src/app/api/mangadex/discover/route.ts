import { NextRequest, NextResponse } from "next/server";
import { MANGADEX_ID } from "@/services/mangadex-pages";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const title = params.get("title")?.trim();
  const id = params.get("id");
  const url = new URL("https://api.mangadex.org/manga");
  if (title && title.length >= 2 && title.length <= 150) {
    url.searchParams.set("title", title);
    url.searchParams.set("limit", "100");
    url.searchParams.append("includes[]", "cover_art");
    url.searchParams.append("includes[]", "author");
    url.searchParams.append("includes[]", "artist");
    url.searchParams.append("contentRating[]", "safe");
    // AniList already excludes adult results. Non-adult manga such as OPM
    // can be suggestive on MangaDex; safe-only search hid the correct edition.
    url.searchParams.append("contentRating[]", "suggestive");
  } else if (id && MANGADEX_ID.test(id)) {
    url.pathname = `/manga/${id}/feed`;
    url.searchParams.set("limit", "100");
    const offset = Number(params.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || offset % 100 !== 0) return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("translatedLanguage[]", "en");
    url.searchParams.set("order[chapter]", "desc");
    url.searchParams.set("includes[]", "scanlation_group");
  } else {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) return NextResponse.json({ error: response.status === 429 ? "MangaDex is busy. Try again shortly." : "MangaDex could not be reached.", status: response.status }, { status: response.status === 429 ? 429 : 502 });
    const data = await response.json();
    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return NextResponse.json({ error: "MangaDex connection timed out." }, { status: 502 });
  }
}
