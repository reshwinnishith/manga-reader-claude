import { MangaDexReader } from "@/components/mangadex-reader";
import { MANGADEX_ID } from "@/services/mangadex-pages";
import { notFound } from "next/navigation";

export default async function MangaDexChapterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ group?: string; series?: string; chapter?: string; prev?: string; prevNumber?: string; next?: string; nextNumber?: string }> }) {
  const { id } = await params;
  if (!MANGADEX_ID.test(id)) notFound();
  const { group, series, chapter, prev, prevNumber, next, nextNumber } = await searchParams;
  return <MangaDexReader id={id} group={typeof group === "string" ? group.slice(0, 200) : "Unknown group"} seriesId={typeof series === "string" && /^al-\d+$/.test(series) ? series : ""} chapterNumber={typeof chapter === "string" ? chapter.slice(0, 20) : ""} previous={typeof prev === "string" && MANGADEX_ID.test(prev) ? { id: prev, number: typeof prevNumber === "string" ? prevNumber.slice(0, 20) : "" } : undefined} next={typeof next === "string" && MANGADEX_ID.test(next) ? { id: next, number: typeof nextNumber === "string" ? nextNumber.slice(0, 20) : "" } : undefined} />;
}
