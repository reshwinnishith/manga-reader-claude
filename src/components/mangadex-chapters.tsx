"use client";

import Link from "next/link";
import { useUserData } from "@/state/use-user-data";
import { useEffect, useState } from "react";
import { listMangaDexChapters, searchMangaDex, type MangaDexChapter } from "@/services/mangadex";

/** Only automatically matched AniList editions can provide in-app chapters. */
export function MangaDexChapters({ title, anilistId }: { title: string; anilistId: number }) {
  const { data } = useUserData();
  const [chapters, setChapters] = useState<MangaDexChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setChapters([]); setLoading(true); setFound(false); setError("");
    (async () => {
      const matches = await searchMangaDex(title, anilistId, controller.signal);
      const match = matches.find((item) => item.verified);
      if (!match) return;
      setFound(true);
      const result = await listMangaDexChapters(match.id, controller.signal);
      const seen = new Set<string>();
      const unique = result.filter((chapter) => {
        if (!/^\d+(?:\.\d+)?$/.test(chapter.number)) return false;
        if (seen.has(chapter.number)) return false;
        seen.add(chapter.number);
        return true;
      }).sort((a, b) => Number(a.number) - Number(b.number));
      if (!controller.signal.aborted) setChapters(unique);
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load chapters.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [title, anilistId]);
  return <section className="section" aria-labelledby="real-chapters-h">
    <h2 id="real-chapters-h">Chapters</h2>
    {loading && <p role="status">Looking for the correct edition…</p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {!loading && !error && !found && <p className="notice">Chapters for this edition aren't available from our current reader source. We won't substitute a different manga or fan work.</p>}
    {!loading && found && chapters.length === 0 && <p className="muted">No readable English chapters found for this edition.</p>}
    {chapters.length > 0 && <><p className="muted">Verified edition on MangaDex · {chapters.length} English chapters found</p>
      <ul className="chapters">{chapters.map((chapter, index) => <li key={chapter.id}>
        <Link className="chapter" href={`/mangadex/read/${chapter.id}?group=${encodeURIComponent(chapter.groupNames.join(", ") || "MangaDex")}&series=${encodeURIComponent(`al-${anilistId}`)}&chapter=${encodeURIComponent(chapter.number)}${index > 0 ? `&prev=${chapters[index - 1]!.id}&prevNumber=${encodeURIComponent(chapters[index - 1]!.number)}` : ""}${index < chapters.length - 1 ? `&next=${chapters[index + 1]!.id}&nextNumber=${encodeURIComponent(chapters[index + 1]!.number)}` : ""}`}>
          <span className="chapter__num">{chapter.number}</span>
          <span className="chapter__body"><span className="chapter__title">{chapter.title || `Chapter ${chapter.number}`}</span><span className="chapter__meta">{data?.progress[`al-${anilistId}`]?.chapters[chapter.id] ? `Resume page ${data.progress[`al-${anilistId}`]!.chapters[chapter.id]!.page + 1} · ` : ""}Read in MangaReader · {chapter.groupNames.join(", ") || "MangaDex"}</span></span>
        </Link>
      </li>)}</ul>
    </>}
  </section>;
}
