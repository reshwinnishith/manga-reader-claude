import { NextRequest, NextResponse } from "next/server";
import { anilistById, anilistSearch, resolveEdition, SourceError } from "@/services/mangadex-server";
import { chapterManifest } from "@/services/mangadex-pages";

/**
 * Coverage audit (issue #5). Disabled in production. For one title:
 * AniList search (or ?al=) → verified MangaDex edition → classified English
 * releases → for the first readable release, the page manifest and the first
 * image (status + content type only; the image is not stored or returned).
 */
let recent: number[] = [];

export async function GET(request: NextRequest) {
  // Audit is an internal diagnostic, never a public preview endpoint.
  // Require an explicitly configured secret even outside production.
  if (process.env.VERCEL_ENV === "production") return NextResponse.json({ error: "Not available." }, { status: 404 });
  const auditToken = process.env.SOURCE_AUDIT_TOKEN;
  if (!auditToken || request.headers.get("authorization") !== `Bearer ${auditToken}`) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= 20) return NextResponse.json({ error: "Audit rate limit: 20 titles/minute." }, { status: 429 });
  recent.push(now);

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim().slice(0, 150) ?? "";
  const alParam = Number(params.get("al"));
  try {
    const identity = Number.isSafeInteger(alParam) && alParam > 0 ? await anilistById(alParam) : q.length >= 2 ? await anilistSearch(q) : null;
    if (!identity) return NextResponse.json({ query: q, anilist: null, status: "no-catalogue-match" });
    const edition = await resolveEdition({ anilistId: identity.id, malId: identity.malId, titles: identity.titles });
    const readable = edition.releases.filter((r) => r.readable);
    const external = edition.releases.filter((r) => r.restriction === "external");
    let pageCheck: { chapterId: string; chapter: string; pages: number; firstImage: { status: number; type: string } } | null = null;
    const first = readable[0];
    if (first) {
      const manifest = await chapterManifest(first.id);
      const image = await fetch(`${manifest.baseUrl}/data-saver/${manifest.hash}/${manifest.files[0]}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      await image.body?.cancel();
      pageCheck = { chapterId: first.id, chapter: first.number, pages: manifest.files.length, firstImage: { status: image.status, type: image.headers.get("content-type") ?? "" } };
    }
    const numbers = new Set(readable.map((r) => `${r.volume}:${r.number}`));
    return NextResponse.json({
      query: q,
      anilist: { id: identity.id, malId: identity.malId, title: identity.title, format: identity.format, country: identity.country },
      status: edition.status,
      verifiedBy: edition.verifiedBy ?? null,
      mangaId: edition.mangaId ?? null,
      sourceTitle: edition.sourceTitle ?? null,
      licensedInEnglish: edition.licensedInEnglish,
      officialLinks: edition.officialLinks,
      readableReleases: readable.length,
      readableChapters: numbers.size,
      externalReleases: external.length,
      hidden: edition.hidden,
      pageCheck,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ query: q, error: error instanceof Error ? error.message : "Audit failed", status: error instanceof SourceError ? error.status : 502 }, { status: 200 });
  }
}
