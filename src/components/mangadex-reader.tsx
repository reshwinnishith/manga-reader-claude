"use client";

import Link from "next/link";
import { PersistenceNotice } from "./persistence-notice";
import { useEffect, useRef, useState } from "react";
import { useUserData } from "@/state/use-user-data";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { readerNeighbors, type MangaDexChapter } from "@/services/mangadex";
import { editionChapters, readerUrl } from "@/services/reading-sources";

type ChapterInfo = { pageCount: number; seriesId: string; number: string; group: string; mangaId: string };

function PageImage({ id, index, eager, onReady }: { id: string; index: number; eager: boolean; onReady(index: number): void }) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  return <div className={`source-page source-page--${state}`} data-page={index}>
    {state === "loading" && <span className="source-page__status" role="status">Loading page {index + 1}…</span>}
    {state === "error" && <div className="source-page__status" role="alert">Page {index + 1} unavailable. <button className="btn btn--secondary" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>Retry page {index + 1}</button></div>}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={attempt} src={`/api/mangadex/page/${id}/${index}${attempt ? `?retry=${attempt}` : ""}`} alt={`Page ${index + 1}`} loading={eager ? "eager" : "lazy"} onLoad={() => { setState("loaded"); onReady(index); }} onError={() => setState("error")} />
  </div>;
}

/** Keyed by chapter ID so all transient state resets during client navigation. */
export function MangaDexReader(props: { id: string; group: string; seriesId?: string; chapterNumber?: string; previous?: { id: string; number: string }; next?: { id: string; number: string } }) {
  return <ChapterReader key={props.id} id={props.id} requestedSeriesId={props.seriesId || ""} />;
}

function ChapterReader({ id, requestedSeriesId }: { id: string; requestedSeriesId: string }) {
  const { data, actions } = useUserData();
  const [info, setInfo] = useState<ChapterInfo | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/mangadex/chapter/${id}`, { signal: controller.signal, credentials: "same-origin" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load chapter");
      if (!Number.isInteger(body.pageCount) || body.pageCount < 1) throw new Error("No pages available");
      if (requestedSeriesId && body.seriesId !== requestedSeriesId) throw new Error("This chapter does not belong to the requested edition.");
      if (!controller.signal.aborted) setInfo(body);
    }).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load chapter"); });
    return () => controller.abort();
  }, [id, requestedSeriesId, attempt]);
  return <main className="source-reader">
    <PersistenceNotice />
    <header className="source-reader__header"><Link href={requestedSeriesId ? `/series/${requestedSeriesId}` : "/library"}>← Chapters</Link><strong>{info ? `Chapter ${info.number || "Special"}` : "Chapter reader"}</strong></header>
    {error ? <div role="alert"><p>{error}</p><button className="btn btn--secondary" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>Retry chapter</button></div> : !info || !data ? <p role="status">Loading chapter…</p> : <LoadedReader id={id} info={info} data={data} actions={actions} />}
    <footer>Pages via MangaDex · No offline chapter downloads</footer>
  </main>;
}

function LoadedReader({ id, info, data, actions }: { id: string; info: ChapterInfo; data: NonNullable<ReturnType<typeof useUserData>["data"]>; actions: ReturnType<typeof useUserData>["actions"] }) {
  const saved = data.savedTitles[info.seriesId];
  const old = data.progress[info.seriesId]?.chapters[id];
  const [page, setPage] = useState(() => {
    if (old) return Math.max(0, Math.min(old.atEnd ? 0 : old.page, info.pageCount - 1));
    // Migrate the previous reader's per-chapter position into the main backup-aware store.
    try {
      const legacy = JSON.parse(localStorage.getItem(`mangareader:chapter:${info.seriesId}:${info.number}`) || "null");
      if (legacy?.chapterId === id && Number.isInteger(legacy.page)) return Math.max(0, Math.min(legacy.page, info.pageCount - 1));
    } catch { /* main store remains authoritative */ }
    return 0;
  });
  const [startPage, setStartPage] = useState(page);
  const [mode, setMode] = useState(data.readerModes[info.seriesId] === "paged-rtl" ? "paged" : "scroll");
  const [atEnd, setAtEnd] = useState(false);
  const [ready, setReady] = useState<Set<number>>(() => new Set());
  const [chapters, setChapters] = useState<MangaDexChapter[]>([]);
  const [navigationError, setNavigationError] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (mode !== "paged") return;
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, select")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setPage((p) => Math.max(0, Math.min(info.pageCount - 1, p + (event.key === "ArrowLeft" ? 1 : -1))));
      setAtEnd(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mode, info.pageCount]);
  useEffect(() => {
    if (mode !== "paged" || page + 1 >= info.pageCount || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    // One page ahead; never mark a preload as viewed or completed.
    const image = new Image();
    image.src = `/api/mangadex/page/${id}/${page + 1}`;
  }, [mode, page, id, info.pageCount]);
  useEffect(() => {
    const controller = new AbortController();
    // Same classified release feed as the chapter list (licensed/uncredited withheld).
    editionChapters(info.mangaId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setChapters(result);
    }).catch(() => { if (!controller.signal.aborted) setNavigationError("Chapter navigation unavailable. Return to Chapters to retry."); });
    return () => controller.abort();
  }, [info.mangaId, id]);
  useEffect(() => {
    if (mode !== "scroll") return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pages = content.current?.querySelectorAll<HTMLElement>("[data-page]");
        if (!pages) return;
        // A viewport midpoint works even when a webtoon page is taller than the viewport.
        let current = startPage;
        for (const element of pages) {
          if (element.getBoundingClientRect().top <= window.innerHeight / 2) current = Number(element.dataset.page);
        }
        setPage(current);
        if (current < info.pageCount - 1) setAtEnd(false);
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [mode, startPage, info.pageCount]);
  useEffect(() => {
    if (!saved || !ready.has(page)) return;
    const base = seriesFromSaved(saved);
    // Source pagination is not a complete publication catalogue; never infer series completion.
    actions.recordProgress({ ...base, status: "ongoing", chapters: [{ id, number: Number(info.number) || 0, title: info.number ? `Chapter ${info.number}` : "Special", pageCount: info.pageCount, releasedAt: "" }] }, id, page, atEnd);
  }, [actions, saved, id, info.number, info.pageCount, page, atEnd, ready]);
  const markReady = (index: number) => setReady((previous) => previous.has(index) ? previous : new Set(previous).add(index));
  const { previous, next } = readerNeighbors(chapters, id);
  const chapterLink = (chapter: MangaDexChapter, label: string) => <Link className="btn btn--secondary" href={readerUrl(chapter, info.seriesId)}>{label}</Link>;
  return <>
    <div className="source-reader__toolbar"><span aria-live="polite">Page {page + 1} / {info.pageCount}</span><button className="btn btn--secondary" onClick={() => {
      const nextMode = mode === "scroll" ? "paged" : "scroll";
      setMode(nextMode); setStartPage(page); setAtEnd(false);
      if (saved) actions.setReaderMode(info.seriesId, nextMode === "scroll" ? "vertical" : "paged-rtl");
      window.scrollTo(0, 0);
    }}>{mode === "scroll" ? "Paged" : "Scroll"}</button></div>
    <p className="source-reader__credit">MangaDex · Translation: {info.group}</p>
    {!saved && <p>Save this title from its detail page to keep reading progress in your library.</p>}
    <div ref={content} onTouchStart={(event) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      touch.current = point ? { x: point.clientX, y: point.clientY } : null;
    }} onTouchEnd={(event) => {
      const point = event.changedTouches[0], start = touch.current;
      touch.current = null;
      if (mode !== "paged" || !start || !point) return;
      const dx = point.clientX - start.x, dy = point.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      setPage((p) => Math.max(0, Math.min(info.pageCount - 1, p + (dx > 0 ? 1 : -1))));
      setAtEnd(false);
    }} className={mode === "paged" ? "source-reader__pages source-reader__pages--paged" : "source-reader__pages"}>
      {mode === "scroll" ? <>
        {startPage > 0 && <button className="btn btn--secondary" onClick={() => { setStartPage(0); setPage(0); setAtEnd(false); window.scrollTo(0, 0); }}>Show earlier pages (1–{startPage})</button>}
        {Array.from({ length: info.pageCount - startPage }, (_, i) => i + startPage).map((i) => <PageImage key={i} id={id} index={i} eager={i <= startPage + 1} onReady={markReady} />)}
      </> : <PageImage key={page} id={id} index={page} eager onReady={markReady} />}
    </div>
    {mode === "paged" && <nav className="source-reader__controls" aria-label="Page navigation"><button className="btn btn--secondary" disabled={page === 0} onClick={() => { setPage((p) => p - 1); setAtEnd(false); }}>Previous page</button><button className="btn btn--secondary" disabled={page === info.pageCount - 1} onClick={() => { setPage((p) => p + 1); setAtEnd(false); }}>Next page</button></nav>}
    {(mode === "scroll" || page === info.pageCount - 1) && <div className="source-reader__end"><button className="btn btn--primary" disabled={!ready.has(info.pageCount - 1) || atEnd} onClick={() => { setPage(info.pageCount - 1); setAtEnd(true); }}>{atEnd ? "Chapter finished" : "Finish chapter"}</button><p>Mark finished after reading the final page.</p></div>}
    <nav aria-label="Chapter navigation" className="source-reader__controls">{previous ? chapterLink(previous, `← Chapter ${previous.number || "Special"}`) : <span />}{next ? chapterLink(next, `Chapter ${next.number || "Special"} →`) : <span />}</nav>
    {navigationError && <p role="status">{navigationError}</p>}
  </>;
}
