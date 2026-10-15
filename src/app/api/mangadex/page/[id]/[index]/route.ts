import { chapterManifest } from "@/services/mangadex-pages";
import { assertChapterReadable } from "@/services/mangadex-chapter";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    if (!/^(0|[1-9][0-9]{0,3})$/.test(index)) return new Response("Invalid page", { status: 400 });
    // Rights are re-checked here: this route can be called directly, without the chapter route.
    await assertChapterReadable(id);
    const manifest = await chapterManifest(id);
    const filename = manifest.files[Number(index)];
    if (!filename) return new Response("Page not found", { status: 404 });
    const url = `${manifest.baseUrl}/data-saver/${manifest.hash}/${filename}`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) return new Response("Image unavailable", { status: 502 });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return new Response("Invalid image", { status: 502 });
    return new Response(response.body, {
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=120" },
    });
  } catch {
    // Includes refusals: a disallowed chapter yields no pages and no detail about why.
    return new Response("Page unavailable", { status: 502 });
  }
}
