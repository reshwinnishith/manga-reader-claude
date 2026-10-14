"use client";

import { useMemo, useState } from "react";
import { READING_STATUSES, type ReadingStatus } from "@/domain/types";
import { formatChapterNumber } from "@/lib/format";
import { filterLibrary, getResumeTarget, getSeriesProgressFraction, type LibraryFilter } from "@/lib/selectors";
import { useCatalog } from "@/state/catalog-context";
import { useUserData } from "@/state/use-user-data";
import { DiscoverIcon } from "./icons";
import { EmptyState, GridSkeleton, PageHeader, SeriesCard } from "./ui";

const FILTERS: { value: LibraryFilter; label: string }[] = [{ value: "all", label: "All" }, ...READING_STATUSES];

const emptyCounts = (): Record<LibraryFilter, number> => ({
  all: 0, reading: 0, planned: 0, "on-hold": 0, dropped: 0, completed: 0,
});

export function LibraryView() {
  const { series: catalog } = useCatalog();
  const { data } = useUserData();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c = emptyCounts();
    if (!data) return c;
    for (const entry of Object.values(data.library)) {
      c.all += 1;
      c[entry.status as ReadingStatus] += 1;
    }
    return c;
  }, [data]);

  const items = useMemo(
    () => (data ? filterLibrary(catalog, data, filter, query) : []),
    [catalog, data, filter, query],
  );

  return (
    <>
      <PageHeader title="Library" subtitle={data ? `${counts.all} series` : undefined} />

      <div className="search">
        <DiscoverIcon width={20} height={20} />
        <input
          type="search"
          className="search__input"
          placeholder="Search your library"
          aria-label="Search your library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
      </div>

      <div className="chips" role="group" aria-label="Filter by reading status">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="chip"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
            <span className="chip__count">{counts[f.value]}</span>
          </button>
        ))}
      </div>

      {!data ? (
        <GridSkeleton count={6} />
      ) : counts.all === 0 ? (
        <EmptyState
          title="Your library is empty"
          body="Add manga and manhwa from Discover and they'll live here."
          action={{ href: "/discover", label: "Find something to read" }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No matches"
          body={query ? `Nothing in your library matches “${query.trim()}”.` : `No series marked ${FILTERS.find((f) => f.value === filter)?.label ?? filter}.`}
        />
      ) : (
        <ul className="grid" aria-label="Library">
          {items.map((s) => {
            const progress = data.progress[s.id];
            const target = getResumeTarget(s, progress);
            const pct = Math.round(getSeriesProgressFraction(s, progress) * 100);
            const caption = progress && target
              ? `${formatChapterNumber(target.chapter.number)} · ${pct}%`
              : `${s.chapters.length} chapters`;
            return (
              <li key={s.id}>
                <SeriesCard series={s} caption={caption} />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
