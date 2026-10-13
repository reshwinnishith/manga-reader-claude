"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { defaultReaderMode, type Chapter, type ReaderMode, type Series } from "@/domain/types";
import { formatChapterLabel, formatChapterNumber } from "@/lib/format";
import { getChapterStartPage } from "@/lib/selectors";
import { useUserData } from "@/state/use-user-data";
import { BackIcon, PagedIcon, ScrollIcon, SkipNextIcon, SkipPrevIcon } from "./icons";
import { PlaceholderPage } from "./placeholder-page";

interface ReaderViewProps {
  series: Series;
  chapterId: string;
}

/**
 * Loads persisted data first (so we know the saved page and reading mode) and
 * only then mounts the session. This avoids flashing page 1 before restoring.
 */
export function ReaderView({ series, chapterId }: ReaderViewProps) {
  const { data } = useUserData();
  const chapterIndex = series.chapters.findIndex((c) => c.id === chapterId);
  const chapter = series.chapters[chapterIndex];

  if (!chapter) {
    return (
      <div className="reader reader--message" role="alert">
        <p>This chapter could not be found.</p>
        <Link href={`/series/${series.id}`} className="btn btn--primary">Back to series</Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="reader reader--message" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p>Loading chapter…</p>
      </div>
    );
  }

  return (
    <ReaderSession
      key={`${chapter.id}`}
      series={series}
      chapter={chapter}
      prev={series.chapters[chapterIndex - 1]}
      next={series.chapters[chapterIndex + 1]}
    />
  );
}

interface SessionProps {
  series: Series;
  chapter: Chapter;
  prev?: Chapter;
  next?: Chapter;
}

function ReaderSession({ series, chapter, prev, next }: SessionProps) {
  const { data, actions } = useUserData();
  const pageCount = chapter.pageCount;
  const mode: ReaderMode = data?.readerModes[series.id] ?? defaultReaderMode(series.type);

  // The saved page is read once; afterwards local state is the source of truth.
  const [page, setPage] = useState(() => getChapterStartPage(chapter, data?.progress[series.id]));
  const [controls, setControls] = useState(true);

  // Persist progress whenever the page changes. The paged "end card" sits one
  // past the last page and counts as the last page.
  const lastPage = pageCount - 1;
  useEffect(() => {
    actions.recordProgress(series, chapter.id, Math.min(page, lastPage));
  }, [actions, series, chapter.id, page, lastPage]);

  const hideControls = useCallback(() => setControls(false), []);
  const toggleControls = useCallback(() => setControls((v) => !v), []);

  const maxPage = mode === "paged-rtl" ? pageCount : lastPage; // paged has an end card
  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(target, maxPage));
      setPage(clamped);
      if (mode === "vertical") {
        document.getElementById(`reader-page-${clamped}`)?.scrollIntoView({ block: "start" });
      }
    },
    [maxPage, mode],
  );

  // Keyboard: arrow keys follow reading direction (right-to-left in paged mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        toggleControls();
        return;
      }
      if (mode !== "paged-rtl") return;
      if (e.key === "ArrowLeft" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        hideControls();
        goTo(page + 1);
      } else if (e.key === "ArrowRight" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        hideControls();
        goTo(page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, page, goTo, hideControls, toggleControls]);

  const toggleMode = () =>
    actions.setReaderMode(series.id, mode === "vertical" ? "paged-rtl" : "vertical");

  const shownPage = Math.min(page, lastPage);
  const isEnd = mode === "paged-rtl" && page >= pageCount;

  return (
    <div className="reader" data-mode={mode} data-controls={controls ? "visible" : "hidden"}>
      {!controls && (
        <button type="button" className="reader__show-controls" onClick={toggleControls}>
          Show controls
        </button>
      )}

      <header className="reader__bar reader__bar--top" aria-hidden={!controls} inert={!controls}>
        <Link href={`/series/${series.id}`} className="icon-btn" aria-label="Back to series">
          <BackIcon />
        </Link>
        <div className="reader__titles">
          <span className="reader__series">{series.title}</span>
          <span className="reader__chapter">
            {formatChapterLabel(chapter)}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--labeled"
          onClick={toggleMode}
          aria-label={mode === "vertical" ? "Switch to paged right-to-left mode" : "Switch to vertical scroll mode"}
        >
          {mode === "vertical" ? <PagedIcon /> : <ScrollIcon />}
          <span>{mode === "vertical" ? "Paged" : "Scroll"}</span>
        </button>
      </header>

      {mode === "vertical" ? (
        <VerticalPages
          key="vertical"
          series={series}
          chapter={chapter}
          next={next}
          initialPage={page}
          onPageChange={setPage}
          onTap={toggleControls}
          onScrollAway={hideControls}
        />
      ) : (
        <PagedPages
          key="paged"
          series={series}
          chapter={chapter}
          next={next}
          prev={prev}
          page={page}
          isEnd={isEnd}
          goTo={(p) => {
            hideControls();
            goTo(p);
          }}
          onTapCenter={toggleControls}
        />
      )}

      <footer className="reader__bar reader__bar--bottom" aria-hidden={!controls} inert={!controls}>
        {prev ? (
          <Link href={`/read/${series.id}/${prev.id}`} className="icon-btn" aria-label={`Previous chapter, ${formatChapterNumber(prev.number)}`}>
            <SkipPrevIcon />
          </Link>
        ) : (
          <span className="icon-btn icon-btn--disabled" aria-label="No previous chapter" aria-disabled="true"><SkipPrevIcon /></span>
        )}

        <div className="reader__scrub">
          <input
            type="range"
            min={0}
            max={Math.max(lastPage, 0)}
            value={shownPage}
            dir={mode === "paged-rtl" ? "rtl" : "ltr"}
            onChange={(e) => goTo(Number(e.target.value))}
            aria-label="Page"
            aria-valuetext={`Page ${shownPage + 1} of ${pageCount}`}
          />
          <span className="reader__count" aria-hidden="true">
            {shownPage + 1} / {pageCount}
          </span>
        </div>

        {next ? (
          <Link href={`/read/${series.id}/${next.id}`} className="icon-btn" aria-label={`Next chapter, ${formatChapterNumber(next.number)}`}>
            <SkipNextIcon />
          </Link>
        ) : (
          <span className="icon-btn icon-btn--disabled" aria-label="No next chapter" aria-disabled="true"><SkipNextIcon /></span>
        )}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EndCard({ series, chapter, next, onBack }: { series: Series; chapter: Chapter; next?: Chapter; onBack?: () => void }) {
  return (
    <div className="endcard">
      <p className="endcard__label">{formatChapterNumber(chapter.number)} complete</p>
      {next ? (
        <>
          <h2 className="endcard__title">Up next: {formatChapterNumber(next.number)}</h2>
          <p className="muted">{next.title}</p>
          <Link href={`/read/${series.id}/${next.id}`} className="btn btn--primary btn--large">
            Continue to next chapter
          </Link>
        </>
      ) : (
        <>
          <h2 className="endcard__title">You&apos;re all caught up</h2>
          <p className="muted">That&apos;s the latest chapter of {series.title}.</p>
        </>
      )}
      {onBack && (
        <button type="button" className="btn btn--ghost" onClick={onBack}>Back to last page</button>
      )}
      <Link href={`/series/${series.id}`} className="btn btn--ghost">Back to series</Link>
    </div>
  );
}

interface VerticalProps {
  series: Series;
  chapter: Chapter;
  next?: Chapter;
  initialPage: number;
  onPageChange: (page: number) => void;
  onTap: () => void;
  onScrollAway: () => void;
}

/** Continuous vertical scroll (manhwa/webtoon style). */
function VerticalPages({ series, chapter, next, initialPage, onPageChange, onTap, onScrollAway }: VerticalProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const initial = useRef(initialPage);
  const lastPage = chapter.pageCount - 1;

  // Restore position, then start observing which page crosses the middle of the screen.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    document.getElementById(`reader-page-${initial.current}`)?.scrollIntoView({ block: "start" });
    lastScrollTop.current = root.scrollTop;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onPageChange(Number((entry.target as HTMLElement).dataset.page));
          }
        }
      },
      { root: null, rootMargin: "-50% 0px -50% 0px", threshold: 0 },
    );
    root.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => observer.observe(el));

    // Fast flings and jumps can skip the last page's midline crossing, so also
    // count the end card coming into view as having reached the last page.
    const endObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onPageChange(lastPage);
    });
    const end = root.querySelector("[data-end]");
    if (end) endObserver.observe(end);

    return () => {
      observer.disconnect();
      endObserver.disconnect();
    };
  }, [onPageChange, lastPage]);

  return (
    <div
      ref={scroller}
      className="reader__scroll"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onTap();
      }}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        if (Math.abs(top - lastScrollTop.current) > 48) {
          lastScrollTop.current = top;
          onScrollAway();
        }
      }}
    >
      {Array.from({ length: chapter.pageCount }, (_, i) => (
        <div key={i} id={`reader-page-${i}`} data-page={i} className="vpage">
          <PlaceholderPage
            seriesId={series.id}
            hue={series.hue}
            chapterNumber={chapter.number}
            page={i}
            pageCount={chapter.pageCount}
            strip
          />
        </div>
      ))}
      <div data-end>
        <EndCard series={series} chapter={chapter} next={next} />
      </div>
    </div>
  );
}

interface PagedProps {
  series: Series;
  chapter: Chapter;
  next?: Chapter;
  prev?: Chapter;
  page: number;
  isEnd: boolean;
  goTo: (page: number) => void;
  onTapCenter: () => void;
}

/** One page at a time, right-to-left (manga). Left tap/swipe-right = forward. */
function PagedPages({ series, chapter, next, page, isEnd, goTo, onTapCenter }: PagedProps) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const forward = () => goTo(page + 1);
  const back = () => goTo(page - 1);

  return (
    <div
      className="reader__paged"
      onTouchStart={(e) => {
        const t = e.touches[0];
        touch.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        const t = e.changedTouches[0];
        touch.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          // Swiping right turns to the next page in right-to-left reading.
          if (dx > 0) forward();
          else back();
        }
      }}
    >
      {isEnd ? (
        <EndCard series={series} chapter={chapter} next={next} onBack={back} />
      ) : (
        <PlaceholderPage
          className="ppage"
          seriesId={series.id}
          hue={series.hue}
          chapterNumber={chapter.number}
          page={page}
          pageCount={chapter.pageCount}
        />
      )}

      {/* Tap zones: left = next page (RTL), right = previous page, centre = controls.
          Omitted on the end card so its buttons stay reachable. */}
      {!isEnd && (
        <>
          <button type="button" className="zone zone--left" aria-label="Next page" onClick={forward} />
          <button type="button" className="zone zone--center" aria-label="Show or hide controls" onClick={onTapCenter} />
          <button type="button" className="zone zone--right" aria-label="Previous page" onClick={back} disabled={page === 0} />
        </>
      )}
    </div>
  );
}
