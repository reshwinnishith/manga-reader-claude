"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { READING_STATUSES, type ReadingStatus, type Series, type UserData } from "@/domain/types";
import { formatChapterNumber } from "@/lib/format";
import {
  filterLibrary,
  getResumeTarget,
  getSeriesProgressFraction,
  type LibraryFilter,
  type LibrarySort,
  type LibraryTypeFilter,
} from "@/lib/selectors";
import { migrateUserData } from "@/lib/user-data";
import { useAllSeries } from "@/state/use-all-series";
import { useUserData } from "@/state/use-user-data";
import { Cover } from "./cover";
import { DiscoverIcon } from "./icons";
import { EmptyState, GridSkeleton, PageHeader, TypeBadge } from "./ui";

const STATUS_FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...READING_STATUSES,
];

const TYPE_FILTERS: { value: LibraryTypeFilter; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "manga", label: "Manga" },
  { value: "manhwa", label: "Manhwa" },
  { value: "manhua", label: "Manhua" },
];

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "recent-active", label: "Recently active" },
  { value: "recent-added", label: "Recently added" },
  { value: "title-asc", label: "Title (A–Z)" },
  { value: "title-desc", label: "Title (Z–A)" },
  { value: "progress", label: "Reading progress" },
];

const emptyCounts = (): Record<LibraryFilter, number> => ({
  all: 0,
  reading: 0,
  planned: 0,
  "on-hold": 0,
  dropped: 0,
  completed: 0,
});

export function getProgressLabel(
  series: Series,
  data?: UserData,
): { label: string; state: "not-started" | "in-progress" | "completed" } {
  if (!data) return { label: "Not started", state: "not-started" };
  const progress = data.progress[series.id];
  const status = data.library[series.id]?.status;

  // 1. Catalog / demo series with known chapters list
  if (series.chapters.length > 0) {
    const fraction = getSeriesProgressFraction(series, progress);
    const pct = Math.round(fraction * 100);
    const target = getResumeTarget(series, progress);

    if (target?.kind === "reread" || pct === 100) {
      return { label: "Completed · 100%", state: "completed" };
    }
    if (status === "completed") {
      return { label: "Completed", state: "completed" };
    }
    if (progress && target && pct > 0) {
      return {
        label: `In progress · ${formatChapterNumber(target.chapter.number)} · ${pct}%`,
        state: "in-progress",
      };
    }
    return { label: `Not started · ${series.chapters.length} ch`, state: "not-started" };
  }

  // 2. External / AniList series (no verified chapter list in catalog)
  if (status === "completed") {
    return { label: "Completed", state: "completed" };
  }
  if (progress && progress.lastChapterId) {
    const cp = progress.chapters[progress.lastChapterId];
    if (cp) {
      if (cp.completed || cp.atEnd) {
        return { label: "In progress · Chapter finished", state: "in-progress" };
      }
      if (cp.pageCount > 0) {
        return { label: `In progress · Page ${cp.page + 1}/${cp.pageCount}`, state: "in-progress" };
      }
      return { label: "In progress", state: "in-progress" };
    }
  }
  return { label: "Not started", state: "not-started" };
}

export function LibraryView() {
  const catalog = useAllSeries();
  const { data, actions, recovery } = useUserData();
  const importRef = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState("");
  const [statusFilter, setStatusFilter] = useState<LibraryFilter>("all");
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>("all");
  const [sort, setSort] = useState<LibrarySort>("recent-active");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c = emptyCounts();
    if (!data) return c;
    for (const s of catalog) {
      const entry = data.library[s.id];
      if (!entry) continue;
      if (typeFilter !== "all" && s.type !== typeFilter) continue;
      c.all += 1;
      if (entry.status in c) {
        c[entry.status as ReadingStatus] += 1;
      }
    }
    return c;
  }, [data, catalog, typeFilter]);

  const items = useMemo(
    () => (data ? filterLibrary(catalog, data, statusFilter, query, typeFilter, sort) : []),
    [catalog, data, statusFilter, query, typeFilter, sort],
  );

  const hasActiveFilters = statusFilter !== "all" || typeFilter !== "all" || query.trim().length > 0;
  const totalInLibrary = data ? Object.keys(data.library).length : 0;

  const resetFilters = () => {
    setStatusFilter("all");
    setTypeFilter("all");
    setQuery("");
  };

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={data ? (hasActiveFilters ? `${items.length} of ${totalInLibrary} series` : `${totalInLibrary} series`) : undefined}
      />

      <div className="dcard__actions" style={{ marginBottom: 16 }}>
        <button
          className="btn btn--secondary btn--compact"
          type="button"
          disabled={!data}
          onClick={() => {
            if (!data) return;
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = recovery ? "mangareader-session-data.json" : "mangareader-library-backup.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          {recovery ? "Export session data" : "Export backup"}
        </button>
        <button
          className="btn btn--secondary btn--compact"
          type="button"
          onClick={() => importRef.current?.click()}
        >
          Import backup
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          aria-label="Import library backup"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const parsed = migrateUserData(JSON.parse(await file.text()));
              if (!parsed) throw new Error("Invalid backup");
              if (!window.confirm("Replace your current library and reading progress with this backup?")) return;
              actions.replaceData(parsed);
              setBackupMessage(
                recovery
                  ? "Backup loaded into this session only. The original stored record is unchanged; session changes cannot be saved."
                  : "Backup restored.",
              );
            } catch {
              setBackupMessage("Couldn't read this backup file.");
            }
            e.target.value = "";
          }}
        />
      </div>

      {recovery && (
        <p className="notice">
          Session export contains only data from this session. It does not contain your original stored library. Use
          Download original stored data in the recovery warning when available.
        </p>
      )}
      {backupMessage && <p role="status" className="muted">{backupMessage}</p>}

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

      {/* Type filter row */}
      <div className="chips" role="group" aria-label="Filter by type">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t.value}
            type="button"
            className="chip"
            aria-pressed={typeFilter === t.value}
            onClick={() => setTypeFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Reading status filter row */}
      <div className="chips" role="group" aria-label="Filter by reading status">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="chip"
            aria-pressed={statusFilter === f.value}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
            <span className="chip__count">{counts[f.value]}</span>
          </button>
        ))}
      </div>

      {/* Sort options selector */}
      <div className="library-sort">
        <label htmlFor="library-sort-select" className="library-sort__label">
          Sort by
        </label>
        <select
          id="library-sort-select"
          className="library-sort__select"
          value={sort}
          onChange={(e) => setSort(e.target.value as LibrarySort)}
          aria-label="Sort library"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {!data ? (
        <GridSkeleton count={6} />
      ) : totalInLibrary === 0 ? (
        <EmptyState
          title="Your library is empty"
          body="Add manga and manhwa from Discover and they'll live here."
          action={{ href: "/discover", label: "Find something to read" }}
        />
      ) : items.length === 0 ? (
        <div className="empty" role="status">
          <p className="empty__title">No matches</p>
          <p className="empty__body">
            {query.trim()
              ? `Nothing in your library matches “${query.trim()}”.`
              : `No ${typeFilter === "all" ? "series" : typeFilter} marked ${
                  STATUS_FILTERS.find((f) => f.value === statusFilter)?.label ?? statusFilter
                }.`}
          </p>
          <div className="empty__action">
            <button type="button" className="btn btn--secondary" onClick={resetFilters}>
              Clear filters
            </button>
          </div>
        </div>
      ) : (
        <ul className="grid" aria-label="Library">
          {items.map((s) => {
            const entry = data.library[s.id]!;
            const { label: progressLabel } = getProgressLabel(s, data);
            return (
              <li key={s.id}>
                <LibraryCard
                  series={s}
                  progressLabel={progressLabel}
                  status={entry.status}
                  onStatusChange={(newStatus) => actions.setReadingStatus(s.id, newStatus)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function LibraryCard({
  series,
  progressLabel,
  status,
  onStatusChange,
}: {
  series: Series;
  progressLabel: string;
  status: ReadingStatus;
  onStatusChange: (status: ReadingStatus) => void;
}) {
  return (
    <div className="card library-card">
      <Link href={`/series/${series.id}`} className="library-card__link" aria-label={`Open ${series.title}`}>
        <div className="card__cover">
          <Cover series={series} />
          <span className="card__badge">
            <TypeBadge type={series.type} />
          </span>
        </div>
        <span className="card__title">{series.title}</span>
        <span className="card__caption">{progressLabel}</span>
      </Link>
      <div className="library-card__status-wrap">
        <label htmlFor={`status-select-${series.id}`} className="sr-only">
          Reading status for {series.title}
        </label>
        <select
          id={`status-select-${series.id}`}
          className="library-card__status-select"
          value={status}
          onChange={(e) => onStatusChange(e.target.value as ReadingStatus)}
          aria-label={`Reading status for ${series.title}`}
        >
          {READING_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
