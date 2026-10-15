"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SavedTitle, SeriesType } from "@/domain/types";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { ANILIST_SITE, MIN_QUERY_LENGTH, getAniListClient, type AniListClient, type CountryFilter } from "@/services/anilist";
import { useTitleSearch } from "@/state/use-title-search";
import { useBrowseSection, type BrowseSort } from "@/state/use-browse-section";
import { useUserData } from "@/state/use-user-data";
import { SaveTitleButton } from "./add-button";
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

/** Sections shown per country filter */
const BROWSE_SECTIONS: Record<
  CountryFilter,
  { id: string; title: string; sort: BrowseSort; country: CountryFilter }[]
> = {
  all: [
    { id: "trending-all", title: "Trending Now", sort: "TRENDING_DESC", country: "all" },
    { id: "popular-manga", title: "Popular Manga", sort: "POPULARITY_DESC", country: "JP" },
    { id: "popular-manhwa", title: "Popular Manhwa", sort: "POPULARITY_DESC", country: "KR" },
  ],
  JP: [
    { id: "trending-manga", title: "Trending Manga", sort: "TRENDING_DESC", country: "JP" },
    { id: "popular-manga", title: "Popular Manga", sort: "POPULARITY_DESC", country: "JP" },
  ],
  KR: [
    { id: "trending-manhwa", title: "Trending Manhwa", sort: "TRENDING_DESC", country: "KR" },
    { id: "popular-manhwa", title: "Popular Manhwa", sort: "POPULARITY_DESC", country: "KR" },
  ],
  CN: [
    { id: "trending-manhua", title: "Trending Manhua", sort: "TRENDING_DESC", country: "CN" },
    { id: "popular-manhua", title: "Popular Manhua", sort: "POPULARITY_DESC", country: "CN" },
  ],
};

export function DiscoverView({ client }: { client?: AniListClient }) {
  const { data } = useUserData();
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState<CountryFilter>("all");
  const anilistClient = client ?? getAniListClient();
  const { view, retry, loadMore } = useTitleSearch(anilistClient, query, country);

  const saved = data?.savedTitles;
  const library = data?.library;
  const savedTitles = useMemo(() => Object.values(saved ?? {})
    .filter((title) => library?.[title.id] && (country === "all" || title.type === FILTERS.find((f) => f.value === country)?.sample))
    .sort((a, b) => (library?.[b.id]?.addedAt ?? "").localeCompare(library?.[a.id]?.addedAt ?? ""))
    .slice(0, 12), [saved, library, country]);

  const isSearching = query.trim().length > 0;
  const sections = BROWSE_SECTIONS[country];

  return (
    <>
      <PageHeader title="Discover" subtitle="Browse manga, manhwa and manhua" />

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
        . Open a title to check verified chapters and official readers. Adult-rated titles are hidden.
      </p>

      {/* ---- Search active: show results ---- */}
      {isSearching && (
        <>
          <div aria-live="polite" className="sr-only">
            {view.status === "success" ? `${view.items.length} result${view.items.length === 1 ? "" : "s"}` : ""}
          </div>

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

          {/* Short query hint */}
          {view.status === "idle" && (
            <p className="muted">
              {query.trim().length > 0
                ? `Keep typing: search starts at ${MIN_QUERY_LENGTH} letters.`
                : "Type a title to search AniList."}
            </p>
          )}
        </>
      )}

      {/* ---- Idle: show browse sections ---- */}
      {!isSearching && (
        <>
          {/* From Your Library */}
          {savedTitles.length > 0 && (
            <section className="browse-section" aria-labelledby="saved-h">
              <div className="section-header">
                <h2 id="saved-h">From Your Library</h2>
              </div>
              <ul className="shelf" aria-label="Saved titles">
                {savedTitles.map((title) => (
                  <li key={title.id} className="shelf__item">
                    <ShelfCard title={title} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* AniList-powered browse sections */}
          {sections.map((sec) => (
            <BrowseSection
              key={sec.id}
              sectionId={sec.id}
              title={sec.title}
              sort={sec.sort}
              country={sec.country}
              client={anilistClient}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---- Browse Section (trending / popular) ----

interface BrowseSectionProps {
  sectionId: string;
  title: string;
  sort: BrowseSort;
  country: CountryFilter;
  client: AniListClient;
}

function BrowseSection({ sectionId, title, sort, country, client }: BrowseSectionProps) {
  const headingId = `${sectionId}-h`;
  const { view, retry } = useBrowseSection(client, sort, country);

  return (
    <section className="browse-section" aria-labelledby={headingId}>
      <div className="section-header">
        <h2 id={headingId}>{title}</h2>
        <span className="browse-section__source">AniList</span>
      </div>

      {view.status === "loading" && (
        <div className="shelf shelf--skeleton" aria-busy="true" aria-label={`Loading ${title}`}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="shelf__item">
              <div className="card">
                <div className="card__cover skeleton" />
                <span className="skeleton skeleton--line" style={{ marginTop: 6 }} />
                <span className="skeleton skeleton--line skeleton--short" />
              </div>
            </div>
          ))}
        </div>
      )}

      {view.status === "error" && (
        <div className="browse-section__error" role="alert">
          <p className="browse-section__error-msg">{view.error.message}</p>
          <button type="button" className="btn btn--ghost btn--compact" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {view.status === "success" && view.items.length > 0 && (
        <ul className="shelf" aria-label={title}>
          {view.items.map((title) => (
            <li key={title.id} className="shelf__item">
              <ShelfCard title={title} />
            </li>
          ))}
        </ul>
      )}

      {view.status === "success" && view.items.length === 0 && (
        <p className="muted">Nothing to show right now.</p>
      )}
    </section>
  );
}

// ---- Shelf card (compact, for browse shelves) ----

function ShelfCard({ title: t }: { title: SavedTitle }) {
  const series = seriesFromSaved(t);
  return (
    <Link href={`/series/${t.id}`} className="card shelf-card" aria-label={`Open ${t.title}`}>
      <div className="card__cover">
        <Cover series={series} />
        <span className="card__badge">
          <TypeBadge type={t.type} />
        </span>
      </div>
      <span className="card__title">{t.title}</span>
      <span className="card__caption">
        {t.authors[0] ?? (t.year ? String(t.year) : STATUS_LABEL[t.status])}
      </span>
      {/* Save button sits outside the Link; wrapping div breaks the interactive nesting */}
      <div className="shelf-card__save" onClick={(e) => e.preventDefault()}>
        <SaveTitleButton title={t} compact />
      </div>
    </Link>
  );
}

// ---- Result card (full, for search results) ----

function ResultCard({ title: t }: { title: SavedTitle }) {
  const series = seriesFromSaved(t);
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
