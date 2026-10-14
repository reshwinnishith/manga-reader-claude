"use client";

import { useEffect, useMemo, useState } from "react";
import type { SavedTitle } from "@/domain/types";
import { normalizeMedia, ANILIST_ENDPOINT } from "@/services/anilist";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { useUserData } from "@/state/use-user-data";
import { SeriesView } from "./series-view";
import { MangaDexChapters } from "./mangadex-chapters";
import { BlockSkeleton, EmptyState } from "./ui";

/** Unsaved AniList titles are viewable without silently adding them to Library. */
export function ExternalSeriesView({ id }: { id: string }) {
  const { data } = useUserData();
  const saved = data?.savedTitles[id];
  const [remote, setRemote] = useState<SavedTitle | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (saved) return;
    const externalId = Number(id.replace(/^al-/, ""));
    if (!/^al-\d+$/.test(id) || !Number.isSafeInteger(externalId)) { setFailed(true); return; }
    const controller = new AbortController();
    setFailed(false);
    fetch(ANILIST_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query ($id: Int) { Media(id: $id, type: MANGA) { id title { english romaji } description(asHtml: false) coverImage { large } status chapters genres startDate { year } countryOfOrigin siteUrl staff(perPage: 3) { edges { node { name { full } } } } } }", variables: { id: externalId } }),
      signal: controller.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error("AniList unavailable");
      const json = await r.json();
      const title = normalizeMedia(json?.data?.Media, new Date().toISOString());
      if (!title || title.id !== id) throw new Error("Title unavailable");
      setRemote(title);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id, saved]);
  const title = saved ?? remote;
  const series = useMemo(() => title ? seriesFromSaved(title) : null, [title]);
  if (!data || (!series && !failed)) return <BlockSkeleton height={320} />;
  if (!series || !title) return <EmptyState title="Couldn't load this title" body="Check your connection and try searching again." action={{ href: "/discover", label: "Discover" }} />;
  return <><SeriesView series={series} savedTitle={title} /><MangaDexChapters title={series.title} anilistId={title.externalId} /></>;
}
