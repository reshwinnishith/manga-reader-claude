"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SeriesType } from "@/domain/types";
import { searchCatalog } from "@/lib/selectors";
import { useCatalog } from "@/state/catalog-context";
import { AddToLibraryButton } from "./add-button";
import { Cover } from "./cover";
import { DiscoverIcon } from "./icons";
import { EmptyState, PageHeader, TypeBadge } from "./ui";

const TYPES: { value: "all" | SeriesType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "manga", label: "Manga" },
  { value: "manhwa", label: "Manhwa" },
];

export function DiscoverView() {
  const { series: catalog } = useCatalog();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | SeriesType>("all");

  const results = useMemo(() => searchCatalog(catalog, query, type), [catalog, query, type]);
  const searching = query.trim().length > 0;

  return (
    <>
      <PageHeader title="Discover" subtitle="Demo catalog — mock data only" />

      <div className="search">
        <DiscoverIcon width={20} height={20} />
        <input
          type="search"
          className="search__input"
          placeholder="Search title, author or genre"
          aria-label="Search the catalog"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
      </div>

      <div className="chips" role="group" aria-label="Filter by type">
        {TYPES.map((t) => (
          <button key={t.value} type="button" className="chip" aria-pressed={type === t.value} onClick={() => setType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      <p className="muted" aria-live="polite">
        {searching ? `${results.length} result${results.length === 1 ? "" : "s"}` : "Popular right now"}
      </p>

      {results.length === 0 ? (
        <EmptyState title="No results" body={`We couldn't find anything for “${query.trim()}”. Try a different title or genre.`} />
      ) : (
        <ul className="discover-list">
          {results.map((s) => (
            <li key={s.id} className="dcard">
              <Link href={`/series/${s.id}`} className="dcard__cover" aria-label={`Open ${s.title}`}>
                <Cover series={s} />
              </Link>
              <div className="dcard__body">
                <Link href={`/series/${s.id}`} className="dcard__title">{s.title}</Link>
                <span className="dcard__meta">
                  <TypeBadge type={s.type} /> {s.author} · {s.year}
                </span>
                <span className="dcard__genres">{s.genres.join(" · ")}</span>
                <p className="dcard__desc">{s.description}</p>
                <div className="dcard__actions">
                  <AddToLibraryButton seriesId={s.id} title={s.title} compact />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
