import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SeriesView } from "@/components/series-view";
import { contentSource } from "@/services/mock-content-source";

type Params = Promise<{ id: string }>;

export async function generateStaticParams() {
  return (await contentSource.listSeries()).map((s) => ({ id: s.id }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const series = await contentSource.getSeries((await params).id);
  return { title: series?.title ?? "Not found" };
}

export default async function SeriesPage({ params }: { params: Params }) {
  const series = await contentSource.getSeries((await params).id);
  if (!series) notFound();
  return <SeriesView series={series} />;
}
