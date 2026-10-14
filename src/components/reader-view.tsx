"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { defaultReaderMode, type Chapter, type ReaderMode, type Series } from "@/domain/types";
import { formatChapterLabel, formatChapterNumber } from "@/lib/format";
import { isEndIndex, pageForIndex, pickVerticalIndex } from "@/lib/reader-position";
import { getChapterStartPage } from "@/lib/selectors";
import { useUserData } from "@/state/use-user-data";
import { BackIcon, PagedIcon, ScrollIcon, SkipNextIcon, SkipPrevIcon } from "./icons";
import { PlaceholderPage } from "./placeholder-page";

/** Ignore forward gestures this soon after arriving on the end card (prevents skipping a chapter). */
const END_CARD_GRACE_MS = 450;

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
      key={chapter.id}
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

/**
 * The reader tracks ONE position per chapter: `index`.
 *   0 .. pageCount-1  -> a page
 *   pageCount         -> the end of the chapter (end card showing / final page scrolled past)
 * Both reader modes read and write this same value, so switching modes, going
 * backwards, or reopening a chapter can never disagree about completion.
 * Only reaching `pageCount` completes a chapter; see `recordProgress`.
 */
function ReaderSession({ series, chapter, prev, next }: SessionProps) {
  const router = useRouter();
  const { data, actions } = useUserData();
  const pageCount = chapter.pageCount;
  const lastPage = pageCount - 1;
  const mode: ReaderMode = data?.readerModes[series.id] ?? defaultReaderMode(series.type);
  const nextHref = next ? `/read/${series.id}/${next.id}` : null;

  // The saved page is read once; afterwards local state is the source of truth.
  const [index, setIndex] = useState(() => getChapterStartPage(chapter, data?.progress[series.id]));
  const [controls, setControls] = useState(true);
  const atEnd = isEndIndex(index, pageCount);

  // Persist on every position change (the store ignores unchanged positions).
  useEffect(() => {
    actions.recordProgress(series, chapter.id, pageForIndex(index, pageCount), isEndIndex(index, pageCount));
  }, [actions, series, chapter.id, index, pageCount]);

  // Remember when the end card appeared so a quick extra tap can't skip the chapter.
  const arrivedAtEnd = useRef(0);
  useEffect(() => {
    if (atEnd) arrivedAtEnd.current = Date.now();
  }, [atEnd]);

  // While reading, the page behind must never scroll or rubber-band.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("reader-open");
    return () => html.classList.remove("reader-open");
  }, []);

  const hideControls = useCallback(() => setControls(false), []);
  const toggleControls = useCallback(() => setControls((v) => !v), []);

  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(target, pageCount));
      setIndex(clamped);
      if (mode === "vertical") {
        const el = document.getElementById(isEndIndex(clamped, pageCount) ? "reader-end" : `reader-page-${clamped}`);
        el?.scrollIntoView({ block: "start" });
      }
    },
    [mode, pageCount],
  );

  /** Forward in reading order. From the end card this continues to the next chapter. */
  const forward = useCallback(() => {
    hideControls();
    if (index < pageCount) {
      goTo(index + 1);
    } else if (nextHref && Date.now() - arrivedAtEnd.current > END_CARD_GRACE_MS) {
      router.push(nextHref);
    }
  }, [index, pageCount, goTo, hideControls, nextHref, router]);

  const back = useCallback(() => {
    hideControls();
    goTo(index - 1);
  }, [index, goTo, hideControls]);

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
        forward();
      } else if (e.key === "ArrowRight" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, forward, back, toggleControls]);

  const toggleMode = () =>
    actions.setReaderMode(series.id, mode === "vertical" ? "paged-rtl" : "vertical");

  const shownPage = pageForIndex(index, pageCount);

  return (
    <div className="reader" data-mode={mode} data-controls={controls ? "visible" : "hidden"} data-at-end={atEnd}>
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
          <span className="reader__chapter">{formatChapterLabel(chapter)}</span>
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
          initialIndex={index}
          onIndexChange={setIndex}
          onTap={toggleControls}
          onScrollAway={hideControls}
        />
      ) : (
        <PagedPages
          key="paged"
          series={series}
          chapter={chapter}
          next={next}
          index={index}
          forward={forward}
          back={back}
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

interface EndCardProps {
  series: Series;
  chapter: Chapter;
  next?: Chapter;
  onBack?: () => void;
}

/** What follows the last page: the way into the next chapter, or a clear caught-up state. */
function EndCard({ series, chapter, next, onBack }: EndCardProps) {
  const finishedSeries = series.status === "completed";
  return (
    <div className="endcard">
      <p className="endcard__label">{formatChapterNumber(chapter.number)} complete</p>
      {next ? (
        <>
          <h2 className="endcard__title">Up next: {formatChapterNumber(next.number)}</h2>
          {next.title.trim().toLowerCase() !== `chapter ${next.number}` && <p className="muted">{next.title}</p>}
          <Link href={`/read/${series.id}/${next.id}`} className="btn btn--primary btn--large">
            Continue to next chapter
          </Link>
        </>
      ) : (
        <>
          <h2 className="endcard__title">{finishedSeries ? "The end" : "You’re all caught up"}</h2>
          <p className="muted">
            {finishedSeries
              ? `You’ve finished ${series.title}.`
              : `That’s the latest chapter of ${series.title}. New chapters will show up on Home.`}
          </p>
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
  initialIndex: number;
  onIndexChange: (index: number) => void;
  onTap: () => void;
  onScrollAway: () => void;
}

/** Continuous vertical scroll (manhwa/webtoon style). */
function VerticalPages({ series, chapter, next, initialIndex, onIndexChange, onTap, onScrollAway }: VerticalProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const frame = useRef(0);
  const initial = useRef(initialIndex);

  // Restore the saved position before first paint.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const target = isEndIndex(initial.current, chapter.pageCount) ? "reader-end" : `reader-page-${initial.current}`;
    document.getElementById(target)?.scrollIntoView({ block: "start" });
    lastScrollTop.current = root.scrollTop;
  }, [chapter.pageCount]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const measure = () => {
    const root = scroller.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const pageTops = Array.from(root.querySelectorAll<HTMLElement>("[data-page]"), (el) => el.getBoundingClientRect().top);
    const endEl = root.querySelector<HTMLElement>("#reader-end");
    onIndexChange(
      pickVerticalIndex({
        pageTops,
        endTop: endEl ? endEl.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
        viewportTop: rect.top,
        viewportHeight: rect.height,
      }),
    );
  };

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
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(measure);
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
      <div id="reader-end">
        <EndCard series={series} chapter={chapter} next={next} />
      </div>
    </div>
  );
}

interface PagedProps {
  series: Series;
  chapter: Chapter;
  next?: Chapter;
  index: number;
  forward: () => void;
  back: () => void;
  onTapCenter: () => void;
}

/**
 * One page at a time, right-to-left (manga). Left tap / swipe right = forward,
 * right tap / swipe left = back. After the last page comes the end card;
 * going forward once more continues to the next chapter.
 */
function PagedPages({ series, chapter, next, index, forward, back, onTapCenter }: PagedProps) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const isEnd = isEndIndex(index, chapter.pageCount);

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
          page={index}
          pageCount={chapter.pageCount}
        />
      )}

      {/* Tap zones: left = forward (RTL), right = back, centre = controls. On the end
          card the card's own buttons sit above the zones, so both stay usable. */}
      <button
        type="button"
        className="zone zone--left"
        aria-label={isEnd ? "Next chapter" : "Next page"}
        onClick={forward}
        disabled={isEnd && !next}
      />
      <button type="button" className="zone zone--center" aria-label="Show or hide controls" onClick={onTapCenter} />
      <button type="button" className="zone zone--right" aria-label="Previous page" onClick={back} disabled={index === 0} />
    </div>
  );
}
