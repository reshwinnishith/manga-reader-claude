import { NextResponse } from "next/server";
import { chapterManifest } from "@/services/mangadex-pages";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const manifest = await chapterManifest(id);
    return NextResponse.json({ pageCount: manifest.files.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chapter unavailable" }, { status: 502 });
  }
}
