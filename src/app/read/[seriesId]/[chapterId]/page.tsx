import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReaderView } from "@/components/reader-view";
import { contentSource } from "@/services/mock-content-source";

type Params = Promise<{ seriesId: string; chapterId: string }>;

export async function generateStaticParams() {
  const all = await contentSource.listSeries();
  return all.flatMap((s) => s.chapters.map((c) => ({ seriesId: s.id, chapterId: c.id })));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { seriesId, chapterId } = await params;
  const series = await contentSource.getSeries(seriesId);
  const chapter = series?.chapters.find((c) => c.id === chapterId);
  return { title: series && chapter ? `${series.title} · Ch. ${chapter.number}` : "Not found" };
}

export default async function ReadPage({ params }: { params: Params }) {
  const { seriesId, chapterId } = await params;
  const series = await contentSource.getSeries(seriesId);
  if (!series || !series.chapters.some((c) => c.id === chapterId)) notFound();
  // key forces a fresh reader (page state, scroll) when moving between chapters
  return <ReaderView key={chapterId} series={series} chapterId={chapterId} />;
}
