"use client";

import { useEffect, useState } from "react";
import { listMangaDexChapters, searchMangaDex, type MangaDexChapter, type MangaDexTitle } from "@/services/mangadex";

/**
 * Checkpoint 1: let the user confirm a MangaDex match and browse chapters.
 * We link to MangaDex for reading until our in-app image reader is ready.
 */
export function MangaDexChapters({ title, anilistId }: { title: string; anilistId: number }) {
  const [matches, setMatches] = useState<MangaDexTitle[]>([]);
  const [selected, setSelected] = useState<MangaDexTitle | null>(null);
  const [chapters, setChapters] = useState<MangaDexChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setMatches([]);
    setSelected(null);
    setChapters([]);
    setLoading(true);
    setError("");
    searchMangaDex(title, anilistId, controller.signal)
      .then(setMatches)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Search failed.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [title, anilistId]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setChapters([]);
    setChapterLoading(true);
    setError("");
    listMangaDexChapters(selected.id, controller.signal)
      .then(setChapters)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't load chapters.");
      })
      .finally(() => { if (!controller.signal.aborted) setChapterLoading(false); });
    return () => controller.abort();
  }, [selected]);

  return (
    <section className="section" aria-label="MangaDex chapters">
      <h2>MangaDex chapters</h2>
      <p className="muted">Choose the correct MangaDex title. Tap a chapter to read inside MangaReader.</p>
      {loading && <p role="status">Searching MangaDex…</p>}
      {error && <p role="alert" className="notice">{error}</p>}
      {!loading && !error && matches.length === 0 && <p className="muted">No matching MangaDex titles found.</p>}
      {!loading && !error && matches.length > 0 && !matches.some((m) => m.verified) && (
        <p className="notice">No verified match for this edition was found on MangaDex. These are other editions or fan works, not confirmed to be the manga you saved.</p>
      )}
      {!loading && matches.some((m) => m.verified) && <p className="muted">✓ Verified AniList match found. Other editions are unverified.</p>}
      {!loading && matches.length > 0 && (
        <div className="chips" role="group" aria-label="Choose a MangaDex title">
          {matches.map((match) => (
            <button
              key={match.id}
              type="button"
              className="chip"
              aria-pressed={selected?.id === match.id}
              onClick={() => setSelected(match)}
            >
              {match.coverUrl && <img src={match.coverUrl} alt="" width={42} height={60} style={{ objectFit: "cover", verticalAlign: "middle", marginRight: 8, borderRadius: 4 }} />}
              <span>{match.verified ? "✓ " : ""}{match.title}<small style={{ display: "block", opacity: .75 }}>{match.category}{match.authors.length ? ` · ${match.authors.join(", ")}` : ""}</small></span>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <>
          <p className="muted">Selected: {selected.title} · English chapters · first 100</p>
          {chapterLoading ? <p role="status">Loading chapters…</p> : chapters.length === 0 && !error ? <p className="muted">No English chapters found.</p> : null}
          <ul className="chapters">
            {chapters.map((chapter) => (
              <li key={chapter.id}>
                <a className="chapter" href={`/mangadex/read/${chapter.id}?group=${encodeURIComponent(chapter.groupNames.join(", ") || "Unknown group")}`} >
                  <span className="chapter__num">{chapter.number}</span>
                  <span className="chapter__body">
                    <span className="chapter__title">{chapter.title || `Chapter ${chapter.number}`}</span>
                    <span className="chapter__meta">{chapter.groupNames.join(", ") || "MangaDex"} · Read in MangaReader →</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
