import { MangaDexReader } from "@/components/mangadex-reader";
import { MANGADEX_ID } from "@/services/mangadex-pages";
import { notFound } from "next/navigation";

export default async function MangaDexChapterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!MANGADEX_ID.test(id)) notFound();
  return <MangaDexReader id={id} />;
}
