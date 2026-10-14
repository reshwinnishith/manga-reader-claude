import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalSeriesView } from "@/components/external-series-view";
import { SeriesView } from "@/components/series-view";
import { contentSource } from "@/services/mock-content-source";

type Params = Promise<{ id: string }>;

const isExternalId = (id: string) => /^al-\d+$/.test(id);

export async function generateStaticParams() {
  return (await contentSource.listSeries()).map((s) => ({ id: s.id }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const series = await contentSource.getSeries((await params).id);
  const id = (await params).id;
  return { title: series?.title ?? (isExternalId(id) ? "Saved title" : "Not found") };
}

export default async function SeriesPage({ params }: { params: Params }) {
  const { id } = await params;
  const series = await contentSource.getSeries(id);
  if (series) return <SeriesView series={series} />;
  // Titles saved from search live in the user's local data; resolve them on the client.
  if (isExternalId(id)) return <ExternalSeriesView id={id} />;
  notFound();
}
