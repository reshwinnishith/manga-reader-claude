"use client";

import Link from "next/link";
import { useUserData } from "@/state/use-user-data";
import { useEffect, useState } from "react";
import type { SavedTitle } from "@/domain/types";
import { chapterSequence, discoverReadingSources, officialDestinations, sourceChapterUrl, type SourceEdition } from "@/services/reading-sources";

export function MangaDexChapters({ title }: { title: SavedTitle }) {
  return <ChapterSources key={`${title.id}:${title.fetchedAt}`} title={title} />;
}

function ChapterSources({ title }: { title: SavedTitle }) {
  const { data } = useUserData();
  const [editions, setEditions] = useState<SourceEdition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    discoverReadingSources(title, controller.signal).then((result) => {
      if (!controller.signal.aborted) setEditions(result);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) { setEditions([]); setError(err instanceof Error ? err.message : "Could not load chapters."); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [title, attempt]);
  const progress = data?.progress[title.id];
  const chapters = editions.flatMap((e) => chapterSequence(e, Object.keys(progress?.chapters || {})).map((chapter) => ({ ...chapter, providerId: e.providerId })));
  const curated = officialDestinations(title);
  const catalogueLinks = editions.flatMap((e) => e.officialLinks || []).filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index);
  const official = [
    ...curated,
    ...catalogueLinks
      .filter((link) => !curated.some((destination) => destination.url === link.url))
      .map((link) => ({ label: link.label, url: link.url, note: "Official English publication recorded by the source catalogue. Availability varies by region and may require a publisher account." })),
  ];
  const hidden = editions.reduce((sum, edition) => sum + Object.values(edition.hidden || {}).reduce((n, count) => n + (count || 0), 0), 0);
  const licensed = editions.some((edition) => edition.licensedInEnglish);
  return <section className="section" aria-labelledby="real-chapters-h">
    <h2 id="real-chapters-h">Chapters</h2>
    {official.map((destination) => <div className="notice" key={destination.url}><a className="link" href={destination.url} target="_blank" rel="noopener noreferrer">{destination.label} ↗</a><p>{destination.note}</p></div>)}
    {loading && <p role="status">Looking for the correct edition…</p>}
    {error && <div role="alert" className="notice">{error} <button className="btn btn--secondary" onClick={() => { setEditions([]); setLoading(true); setError(""); setAttempt((n) => n + 1); }}>Retry chapters</button></div>}
    {!loading && !error && !editions.length && <p className="notice">No verified in-app chapter source for this edition.{official.length ? " Use the official reader above." : " We will not substitute a different edition."}</p>}
    {!loading && editions.length > 0 && !chapters.length && <p className="muted">Edition verified. No available English chapters on MangaDex.{hidden > 0 ? ` ${hidden} release${hidden === 1 ? "" : "s"} withheld (${licensed ? "official English link present or " : ""}uncredited uploads are not shown).` : ""}{official.length ? " Use the official reader above." : ""}</p>}
    {chapters.length > 0 && <><p className="muted">Verified edition on MangaDex · {chapters.filter((c) => c.readable).length} readable English releases · Specials are listed separately.{hidden > 0 ? ` · ${hidden} withheld` : ""}</p>
      <ul className="chapters">{chapters.map((chapter) => {
        const saved = progress?.chapters[chapter.id];
        const body = <><span className="chapter__num">{chapter.number || "Special"}</span><span className="chapter__body"><span className="chapter__title">{chapter.title || (chapter.number ? `Chapter ${chapter.number}` : "Special")}</span><span className="chapter__meta">{chapter.volume ? `Vol. ${chapter.volume} · ` : ""}{saved ? saved.completed ? "Read · " : `Resume page ${saved.page + 1} · ` : ""}{chapter.readable ? "Read in MangaReader" : chapter.externalUrl ? "Read at source ↗" : "Pages unavailable"} · {chapter.groupNames.join(", ") || "Group not credited"}</span></span></>;
        return <li key={chapter.id}>{chapter.readable ? <Link className="chapter" href={sourceChapterUrl(chapter.providerId, chapter, title.id)}>{body}</Link> : chapter.externalUrl ? <a className="chapter" href={chapter.externalUrl} target="_blank" rel="noopener noreferrer">{body}</a> : <div className="chapter" aria-disabled="true">{body}</div>}</li>;
      })}</ul>
    </>}
  </section>;
}
