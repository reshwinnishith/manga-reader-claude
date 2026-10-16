"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { READING_STATUSES, type Series, type SavedTitle } from "@/domain/types";
import { formatChapterNumber, formatDate, pluralize } from "@/lib/format";
import { getChapterState, getResumeTarget, getSeriesProgressFraction } from "@/lib/selectors";
import { readerUrl } from "@/services/reading-sources";
import { useUserData } from "@/state/use-user-data";
import { AddToLibraryButton, SaveTitleButton } from "./add-button";
import { Cover } from "./cover";
import { BackIcon, CheckIcon, PlayIcon, SortIcon } from "./icons";
import { ProgressBar, SectionHeader, TypeBadge } from "./ui";

const PUBLICATION_LABEL = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "On hiatus",
  cancelled: "Cancelled",
  upcoming: "Upcoming",
} as const;

export function SeriesView({ series, savedTitle }: { series: Series; savedTitle?: SavedTitle }) {
  const { data, actions } = useUserData();
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const progress = data?.progress[series.id];
  const entry = data?.library[series.id];
  const target = useMemo(() => getResumeTarget(series, progress), [series, progress]);
  const fraction = getSeriesProgressFraction(series, progress);
  const chapters = useMemo(
    () => (newestFirst ? [...series.chapters].reverse() : series.chapters),
    [series.chapters, newestFirst],
  );
  // AniList titles have empty catalogue chapters; resume from saved MangaDex progress instead.
  const sourceChapter = series.source && progress ? progress.chapters[progress.lastChapterId] : undefined;
  const sourceResumeHref = sourceChapter && !sourceChapter.atEnd
    ? readerUrl({ id: progress!.lastChapterId, number: "" }, series.id)
    : null;

  const ctaLabel =
    !data || !target ? "Start reading"
    : target.kind === "start" ? "Start reading"
    : target.kind === "reread" ? (series.status === "completed" ? "Read again" : "Caught up · Read again")
    : `Continue · ${formatChapterNumber(target.chapter.number)}`;

  return (
    <article>
      <Link href="/library" className="back-link">
        <BackIcon width={20} height={20} /> Library
      </Link>

      <header className="series-head">
        <div className="series-head__cover"><Cover series={series} /></div>
        <div className="series-head__info">
          <h1 className="series-title">{series.title}</h1>
          {!series.source && <p className="notice">Demo title · Illustrated placeholder pages</p>}
          <p className="muted">{[series.author, series.year || null].filter(Boolean).join(" · ")}</p>
          <div className="meta-row">
            <TypeBadge type={series.type} />
            <span className="badge">{PUBLICATION_LABEL[series.status]}</span>
            {series.source ? (
              series.reportedChapters ? <span className="badge">{pluralize(series.reportedChapters, "chapter")} listed</span> : null
            ) : (
              <span className="badge">{pluralize(series.chapters.length, "chapter")}</span>
            )}
          </div>
          <p className="muted">{series.genres.join(" · ")}</p>
        </div>
      </header>

      <div className="actions">
        {target ? (
          <Link
            className="btn btn--primary btn--large"
            href={`/read/${series.id}/${target.chapter.id}`}
          >
            <PlayIcon width={20} height={20} /> {ctaLabel}
          </Link>
        ) : sourceResumeHref && sourceChapter ? (
          <Link className="btn btn--primary btn--large" href={sourceResumeHref}>
            <PlayIcon width={20} height={20} /> Continue · page {sourceChapter.page + 1}
          </Link>
        ) : sourceChapter?.atEnd ? (
          <span className="btn btn--secondary btn--large" aria-disabled="true">Chapter finished · choose next below</span>
        ) : (
          !series.source && <span className="btn btn--secondary btn--large" aria-disabled="true">No chapters yet</span>
        )}
        {savedTitle ? <SaveTitleButton title={savedTitle} /> : <AddToLibraryButton seriesId={series.id} title={series.title} />}
      </div>

      {data && progress && !series.source && (
        <div className="progress-block">
          <div className="progress-block__row">
            <span>{Math.round(fraction * 100)}% complete</span>
            {target && target.kind !== "start" && (
              <span className="muted">
                {formatChapterNumber(target.chapter.number)}, page {target.page + 1}/{target.chapter.pageCount}
              </span>
            )}
          </div>
          <ProgressBar value={fraction} label={`${series.title} reading progress`} />
        </div>
      )}
      {data && sourceChapter && (
        <div className="progress-block">
          <div className="progress-block__row">
            <span>{sourceChapter.atEnd ? "Last chapter finished" : `Resume page ${sourceChapter.page + 1} of ${sourceChapter.pageCount}`}</span>
          </div>
          <ProgressBar value={sourceChapter.pageCount ? (sourceChapter.atEnd ? 1 : (sourceChapter.page + 1) / sourceChapter.pageCount) : 0} label={`${series.title} reading progress`} />
        </div>
      )}

      {entry && (
        <div className="chips" role="group" aria-label="Reading status">
          {READING_STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              className="chip"
              aria-pressed={entry.status === s.value}
              onClick={() => actions.setReadingStatus(series.id, s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {savedTitle?.alternateTitles?.length ? (
        <details className="section">
          <summary>Alternate titles</summary>
          <ul>
            {savedTitle.alternateTitles
              .filter((t) => t !== series.title)
              .map((t) => (
                <li key={t} lang={/[ぁ-龯]/.test(t) ? "ja" : undefined}>
                  {t}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <section className="section">
        <p className={`desc ${expanded ? "" : "desc--clamped"}`}>{series.description}</p>
        {series.description !== "No description available." && <button type="button" className="link" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Show less" : "Read more"}
        </button>}
      </section>

      {series.source && (
        <section className="section" aria-label="About this listing">
          <p className="notice">
            Metadata: AniList.
            {series.externalUrl && (
              <>
                {" "}
                <a className="link" href={series.externalUrl} target="_blank" rel="noopener noreferrer">
                  View on AniList
                </a>
              </>
            )}
          </p>
        </section>
      )}

      {!series.source && (
      <section className="section" aria-labelledby="chapters-h">
        <SectionHeader
          id="chapters-h"
          title="Chapters"
          action={
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => setNewestFirst((v) => !v)}
              aria-label={newestFirst ? "Sorted newest first. Switch to oldest first" : "Sorted oldest first. Switch to newest first"}
            >
              <SortIcon width={18} height={18} /> {newestFirst ? "Newest" : "Oldest"}
            </button>
          }
        />
        <ul className="chapters">
          {chapters.map((c) => {
            const state = getChapterState(c, progress);
            const cp = progress?.chapters[c.id];
            return (
              <li key={c.id}>
                <Link
                  href={`/read/${series.id}/${c.id}`}
                  className={`chapter chapter--${state}`}
                  aria-label={`${formatChapterNumber(c.number)}, ${c.title}, ${state === "read" ? "read" : state === "in-progress" ? "in progress" : "unread"}`}
                >
                  <span className="chapter__num">{c.number}</span>
                  <span className="chapter__body">
                    <span className="chapter__title">{c.title}</span>
                    <span className="chapter__meta">
                      {formatDate(c.releasedAt)} · {pluralize(c.pageCount, "page")}
                      {state === "in-progress" && cp ? ` · on page ${cp.page + 1}` : ""}
                    </span>
                  </span>
                  {state === "read" && <CheckIcon className="chapter__done" width={20} height={20} aria-label="Read" />}
                  {state === "in-progress" && <span className="dot" aria-hidden="true" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      )}
    </article>
  );
}
