"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatChapterNumber, formatDate, pluralize } from "@/lib/format";
import { getContinueReading, getNewChapters, getRecentlyAdded } from "@/lib/selectors";
import { useAllSeries } from "@/state/use-all-series";
import { useUserData } from "@/state/use-user-data";
import { Cover } from "./cover";
import { PlayIcon } from "./icons";
import { BlockSkeleton, EmptyState, PageHeader, ProgressBar, SectionHeader, SeriesCard } from "./ui";

export function HomeView() {
  const catalog = useAllSeries();
  const { data } = useUserData();

  const view = useMemo(() => {
    if (!data) return null;
    return {
      continueItems: getContinueReading(catalog, data).filter((item) => !item.series.id.startsWith("demo-") && !item.series.id.startsWith("sample-")),
      newChapters: getNewChapters(catalog, data),
      recent: getRecentlyAdded(catalog, data).filter((s) => s.id.startsWith("al-")).slice(0, 10),
    };
  }, [catalog, data]);

  if (!view) {
    return (
      <>
        <PageHeader title="Home" />
        <div className="stack" aria-busy="true">
          <BlockSkeleton height={190} />
          <BlockSkeleton height={120} />
        </div>
      </>
    );
  }

  const [hero, ...rest] = view.continueItems;

  return (
    <>
      <PageHeader title="Home" subtitle="Pick up where you left off" />

      <section className="section" aria-labelledby="my-library-h">
        <SectionHeader id="my-library-h" title="My Manga" action={<Link href="/library" className="link">See all</Link>} />
        {view.recent.length ? <div className="shelf" role="list">{view.recent.map((s) => <div role="listitem" key={s.id} className="shelf__item"><SeriesCard series={s} caption="Saved to library" /></div>)}</div> : <EmptyState title="No manga saved yet" body="Find a title in Discover and tap Add." action={{ href: "/discover", label: "Discover manga" }} />}
      </section>
      <section aria-labelledby="continue-h" className="section">
        <SectionHeader id="continue-h" title="Continue Reading" />
        {hero ? (
          <Link
            href={`/read/${hero.series.id}/${hero.target.chapter.id}`}
            className="hero"
            aria-label={`Continue ${hero.series.title}, ${formatChapterNumber(hero.target.chapter.number)}, page ${hero.target.page + 1}`}
          >
            <div className="hero__cover"><Cover series={hero.series} /></div>
            <div className="hero__body">
              <span className="hero__title">{hero.series.title}</span>
              <span className="hero__meta">
                {formatChapterNumber(hero.target.chapter.number)} · Page {hero.target.page + 1} of {hero.target.chapter.pageCount}
              </span>
              <ProgressBar value={hero.fraction} label={`${hero.series.title} progress`} />
              <span className="btn btn--primary hero__cta" aria-hidden="true">
                <PlayIcon width={18} height={18} /> Continue
              </span>
            </div>
          </Link>
        ) : (
          <EmptyState
            title="Nothing in progress"
            body="Find a series you like and start reading. It will show up here."
            action={{ href: "/discover", label: "Discover series" }}
          />
        )}

        {rest.length > 0 && (
          <div className="shelf" role="list" aria-label="More in progress">
            {rest.map((item) => (
              <div role="listitem" key={item.series.id} className="shelf__item">
                <SeriesCard
                  series={item.series}
                  caption={`${formatChapterNumber(item.target.chapter.number)} · p. ${item.target.page + 1}`}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="new-h">
        <SectionHeader id="new-h" title="New Chapters" />
        {view.newChapters.length === 0 ? (
          <EmptyState title="You're all caught up" body="New chapters from series in your library will appear here." />
        ) : (
          <ul className="rows">
            {view.newChapters.slice(0, 6).map(({ series, chapters, latest }) => (
              <li key={series.id}>
                <Link href={`/series/${series.id}`} className="row">
                  <div className="row__cover"><Cover series={series} /></div>
                  <div className="row__body">
                    <span className="row__title">{series.title}</span>
                    <span className="row__meta">
                      {formatChapterNumber(latest.number)} · {formatDate(latest.releasedAt)}
                    </span>
                  </div>
                  <span className="pill" aria-label={`${pluralize(chapters.length, "new chapter")}`}>
                    {chapters.length} new
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="recent-h">
        <SectionHeader id="recent-h" title="Recently Added" action={<Link href="/library" className="link">Library</Link>} />
        {view.recent.length === 0 ? (
          <EmptyState
            title="Your library is empty"
            body="Add series from Discover to build your collection."
            action={{ href: "/discover", label: "Browse Discover" }}
          />
        ) : (
          <div className="shelf" role="list">
            {view.recent.map((s) => (
              <div role="listitem" key={s.id} className="shelf__item">
                <SeriesCard series={s} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
