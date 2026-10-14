"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SavedTitle, SeriesType } from "@/domain/types";
import { searchCatalog } from "@/lib/selectors";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { ANILIST_SITE, MIN_QUERY_LENGTH, getAniListClient, type AniListClient, type CountryFilter } from "@/services/anilist";
import { useCatalog } from "@/state/catalog-context";
import { useTitleSearch } from "@/state/use-title-search";
import { useUserData } from "@/state/use-user-data";
import { AddToLibraryButton, SaveTitleButton } from "./add-button";
import { Cover } from "./cover";
import { DiscoverIcon } from "./icons";
import { EmptyState, ErrorState, PageHeader, TypeBadge } from "./ui";

const FILTERS: { value: CountryFilter; label: string; sample: "all" | SeriesType }[] = [
  { value: "all", label: "All", sample: "all" },
  { value: "JP", label: "Manga", sample: "manga" },
  { value: "KR", label: "Manhwa", sample: "manhwa" },
  { value: "CN", label: "Manhua", sample: "manhua" },
];

const STATUS_LABEL = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "On hiatus",
  cancelled: "Cancelled",
  upcoming: "Upcoming",
} as const;

export function DiscoverView({ client }: { client?: AniListClient }) {
  const { series: catalog } = useCatalog();
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState<CountryFilter>("all");
  const { view, retry, loadMore } = useTitleSearch(client ?? getAniListClient(), query, country);

  const sampleType = FILTERS.find((f) => f.value === country)?.sample ?? "all";
  const samples = useMemo(() => searchCatalog(catalog, "", sampleType), [catalog, sampleType]);

  return (
    <>
      <PageHeader title="Discover" subtitle="Search manga, manhwa and manhua" />

      <div className="search">
        <DiscoverIcon width={20} height={20} />
        <input
          type="search"
          className="search__input"
          placeholder="Search by title"
          aria-label="Search titles"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>

      <div className="chips" role="group" aria-label="Filter by type">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className="chip" aria-pressed={country === f.value} onClick={() => setCountry(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      <p className="attribution">
        Results from{" "}
        <a href={ANILIST_SITE} target="_blank" rel="noopener noreferrer">
          AniList
        </a>
        . Title info only; reading isn&apos;t available yet. Adult-rated titles are hidden.
      </p>

      <div aria-live="polite" className="sr-only">
        {view.status === "success" ? `${view.items.length} result${view.items.length === 1 ? "" : "s"}` : ""}
      </div>

      {view.status === "idle" && (
        <>
          <p className="muted">
            {query.trim().length > 0
              ? `Keep typing: search starts at ${MIN_QUERY_LENGTH} letters.`
              : "Type a title to search AniList."}
          </p>
          {samples.length > 0 && (
            <section className="section-note" aria-labelledby="samples-h">
              <h2 id="samples-h" className="muted">Sample titles (demo, readable)</h2>
              <ul className="discover-list">
                {samples.map((s) => (
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
            </section>
          )}
        </>
      )}

      {view.status === "loading" && (
        <ul className="discover-list" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="dcard dcard--skeleton">
              <div className="dcard__cover skeleton" />
              <div className="dcard__body">
                <span className="skeleton skeleton--line" />
                <span className="skeleton skeleton--line skeleton--short" />
                <span className="skeleton skeleton--line" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.status === "error" && (
        <ErrorState
          title={view.error.kind === "rate-limited" ? "Slow down a little" : "Search didn't work"}
          body={view.error.message}
          action={
            <button type="button" className="btn btn--primary" onClick={retry}>
              Try again
            </button>
          }
        />
      )}

      {view.status === "success" && view.items.length === 0 && (
        <EmptyState
          title="No results"
          body={`Nothing found for “${query.trim()}”. Check the spelling, try the English or romanised title, or switch the type filter.`}
        />
      )}

      {view.status === "success" && view.items.length > 0 && (
        <>
          <ul className="discover-list" aria-label="Search results">
            {view.items.map((t) => (
              <ResultCard key={t.id} title={t} />
            ))}
          </ul>
          {view.moreError && (
            <p className="retry-note" role="alert">{view.moreError.message}</p>
          )}
          {(view.hasNextPage || view.moreError) && (
            <div className="load-more">
              <button type="button" className="btn btn--secondary" onClick={loadMore} disabled={view.loadingMore}>
                {view.loadingMore ? "Loading…" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ResultCard({ title: t }: { title: SavedTitle }) {
  const { data } = useUserData();
  const series = seriesFromSaved(t);
  const saved = !!data?.library[t.id];
  const meta = [t.authors[0], t.year].filter(Boolean).join(" · ");
  const details = [STATUS_LABEL[t.status], t.reportedChapters ? `${t.reportedChapters} chapters` : null].filter(Boolean).join(" · ");

  return (
    <li className="dcard" style={{ position: "relative" }}>
      <div className="dcard__cover"><Cover series={series} /></div>
      <div className="dcard__body">
        <Link href={`/series/${t.id}`} aria-label={`Open ${t.title}`} style={{ position: "absolute", inset: 0, zIndex: 1 }} />
        <span className="dcard__title">{t.title}</span>
        <span className="dcard__meta">
          <TypeBadge type={t.type} /> {meta}
        </span>
        <span className="dcard__genres">{[...t.genres.slice(0, 3), details].filter(Boolean).join(" · ")}</span>
        {t.description ? (
          <p className="dcard__desc">{t.description}</p>
        ) : (
          <p className="dcard__desc dcard__desc--empty">No description available.</p>
        )}
        <div className="dcard__links" style={{ position: "relative", zIndex: 2 }}>
          <div className="dcard__actions">
            <SaveTitleButton title={t} compact />
          </div>
          <a className="dcard__source" href={t.url} target="_blank" rel="noopener noreferrer" aria-label={`${t.title} on AniList (opens in a new tab)`}>
            View on AniList
          </a>
        </div>
      </div>
    </li>
  );
}
