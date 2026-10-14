"use client";

import { useMemo } from "react";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { useUserData } from "@/state/use-user-data";
import { SeriesView } from "./series-view";
import { MangaDexChapters } from "./mangadex-chapters";
import { BlockSkeleton, EmptyState } from "./ui";

/**
 * Detail page for a title saved from search. Its metadata lives in the user's
 * local data (not in the static catalog), so it is resolved on the client.
 */
export function ExternalSeriesView({ id }: { id: string }) {
  const { data } = useUserData();
  const saved = data?.savedTitles[id];
  const series = useMemo(() => (saved ? seriesFromSaved(saved) : null), [saved]);

  if (!data) return <BlockSkeleton height={320} />;
  if (!series) {
    return (
      <EmptyState
        title="This title isn't saved on this device"
        body="Titles from search are stored in the browser where you added them. Search for it again to add it here."
        action={{ href: "/discover", label: "Search titles" }}
      />
    );
  }
  return <><SeriesView series={series} /><MangaDexChapters title={series.title} anilistId={saved?.externalId ?? 0} /></>;
}
