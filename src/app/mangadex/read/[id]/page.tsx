import { MangaDexReader } from "@/components/mangadex-reader";
import { MANGADEX_ID } from "@/services/mangadex-pages";
import { notFound } from "next/navigation";

export default async function MangaDexChapterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ group?: string }> }) {
  const { id } = await params;
  if (!MANGADEX_ID.test(id)) notFound();
  const { group } = await searchParams;
  return <MangaDexReader id={id} group={typeof group === "string" ? group.slice(0, 200) : "Unknown group"} />;
}
