import { NextRequest, NextResponse } from "next/server";
import { editionReleases, resolveEdition, SourceError } from "@/services/mangadex-server";
import { MANGADEX_UUID } from "@/services/source-policy";

/**
 * GET ?al=<AniList id>&mal=<MyAnimeList id>&t=<title>&t=<alias>  → verified edition + classified releases
 * GET ?manga=<MangaDex id>                                       → classified releases (reader navigation)
 *
 * Identity is decided by catalogue IDs. Titles only locate candidates. Responses
 * are cached briefly at the edge so new chapters appear without a deployment.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const manga = params.get("manga");
    if (manga) {
      if (!MANGADEX_UUID.test(manga)) return NextResponse.json({ error: "Invalid MangaDex title." }, { status: 400 });
      return ok(await editionReleases(manga));
    }
    const al = Number(params.get("al"));
    const malRaw = params.get("mal");
    const mal = malRaw ? Number(malRaw) : null;
    const titles = params.getAll("t").map((t) => t.slice(0, 150));
    if (!Number.isSafeInteger(al) || al <= 0 || (mal !== null && (!Number.isSafeInteger(mal) || mal <= 0)) || titles.length === 0 || titles.length > 4) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    return ok(await resolveEdition({ anilistId: al, malId: mal, titles }));
  } catch (error) {
    const status = error instanceof SourceError ? error.status : 502;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chapter source unavailable." }, { status: status === 404 ? 404 : status === 429 ? 429 : status === 400 ? 400 : 502 });
  }
}

const ok = (body: unknown) => NextResponse.json(body, { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } });
