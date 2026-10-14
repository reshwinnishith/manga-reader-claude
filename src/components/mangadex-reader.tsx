"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function MangaDexReader({ id, group }: { id: string; group: string }) {
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
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load chapter"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  return (
    <main style={{ minHeight: "100dvh", background: "#101015", color: "#fff", padding: "12px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12 }}>
        <Link href="/library" style={{ color: "inherit" }}>← Library</Link>
        <strong>Chapter reader</strong>
        <button type="button" onClick={() => setMode(mode === "scroll" ? "paged" : "scroll")}>{mode === "scroll" ? "Paged" : "Scroll"}</button>
      </header>
      <p style={{ textAlign: "center", fontSize: 12, opacity: 0.7 }}>Pages via MangaDex · Translation: {group}</p>
      {loading && <p role="status">Loading chapter…</p>}
      {error && <p role="alert">{error}</p>}
      {count > 0 && (mode === "scroll" ? (
        <div style={{ maxWidth: 850, margin: "auto" }}>
          {Array.from({ length: count }, (_, index) => (
            // Images are proxied by our own server to respect MangaDex image host restrictions.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={index} src={`/api/mangadex/page/${id}/${index}`} alt={`Page ${index + 1}`} loading={index < 2 ? "eager" : "lazy"} style={{ width: "100%", height: "auto", display: "block" }} />
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
