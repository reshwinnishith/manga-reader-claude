"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useUserData } from "@/state/use-user-data";
import { seriesFromSaved } from "@/lib/series-from-saved";

export function MangaDexReader({ id, group, seriesId = "", chapterNumber = "" }: { id: string; group: string; seriesId?: string; chapterNumber?: string }) {
  const { data, actions } = useUserData();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"scroll" | "paged">("scroll");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/mangadex/chapter/${id}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load chapter");
        if (typeof body.pageCount !== "number" || body.pageCount < 1) throw new Error("No pages available");
        setCount(body.pageCount);
        if (seriesId && chapterNumber) {
          try { const old = JSON.parse(localStorage.getItem(`mangareader:chapter:${seriesId}:${chapterNumber}`) || "null"); if (old?.chapterId === id && Number.isInteger(old?.page)) setPage(Math.max(0, Math.min(old.page, body.pageCount - 1))); } catch { /* ignore */ }
        }
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load chapter"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, seriesId, chapterNumber]);

  useEffect(() => {
    if (mode !== "scroll" || !count || !scrollRef.current) return;
    const elements = Array.from(scrollRef.current.querySelectorAll<HTMLImageElement>("img[data-page]"));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setPage(Number((visible.target as HTMLElement).dataset.page) || 0);
    }, { threshold: [0.25, 0.5, 0.75] });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [mode, count]);

  useEffect(() => {
    if (!seriesId || !chapterNumber || !count) return;
    try { localStorage.setItem(`mangareader:chapter:${seriesId}:${chapterNumber}`, JSON.stringify({ chapterId: id, page, pageCount: count, updatedAt: new Date().toISOString() })); } catch { /* storage may be unavailable */ }
    const saved = data?.savedTitles[seriesId];
    if (saved) {
      const base = seriesFromSaved(saved);
      const series = { ...base, status: "ongoing" as const, chapters: [{ id, number: Number(chapterNumber) || 0, title: `Chapter ${chapterNumber}`, pageCount: count, releasedAt: new Date().toISOString() }] };
      actions.recordProgress(series, id, page);
    }
  }, [seriesId, chapterNumber, count, page, id, data?.savedTitles, actions]);

  return (
    <main style={{ minHeight: "100dvh", background: "#101015", color: "#fff", padding: "12px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12 }}>
        <Link href={seriesId ? `/series/${seriesId}` : "/library"} style={{ color: "inherit" }}>← Chapters</Link>
        <strong>Chapter reader</strong>
        <button type="button" onClick={() => setMode(mode === "scroll" ? "paged" : "scroll")}>{mode === "scroll" ? "Paged" : "Scroll"}</button>
      </header>
      <p style={{ textAlign: "center", fontSize: 12, opacity: 0.7 }}>Pages via MangaDex · Translation: {group}</p>
      {loading && <p role="status">Loading chapter…</p>}
      {error && <p role="alert">{error}</p>}
      {count > 0 && (mode === "scroll" ? (
        <div ref={scrollRef} style={{ maxWidth: 850, margin: "auto" }}><p style={{ textAlign: "center" }}>Scroll reading · Your position is saved automatically.</p>
          {Array.from({ length: count }, (_, index) => (
            // Images are proxied by our own server to respect MangaDex image host restrictions.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={index} data-page={index} src={`/api/mangadex/page/${id}/${index}`} alt={`Page ${index + 1}`} loading={index < 2 ? "eager" : "lazy"} style={{ width: "100%", height: "auto", display: "block" }} />
          ))}
        </div>
      ) : (
        <div style={{ maxWidth: 850, margin: "auto", textAlign: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/mangadex/page/${id}/${page}`} alt={`Page ${page + 1}`} style={{ maxWidth: "100%", maxHeight: "78dvh", objectFit: "contain" }} />
          <nav style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: 16 }}>
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span>{page + 1} / {count}</span>
            <button type="button" disabled={page === count - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
          </nav>
        </div>
      ))}
      <footer style={{ textAlign: "center", padding: 20, fontSize: 12 }}>Powered by MangaDex · No chapter downloads stored</footer>
    </main>
  );
}
