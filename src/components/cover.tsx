"use client";

import { useId, useState } from "react";
import type { Series } from "@/domain/types";
import { createRng, hashString } from "@/lib/placeholder";

type CoverSeries = Pick<Series, "id" | "title" | "hue" | "type"> & { coverUrl?: string };

/**
 * Cover art (2:3). Titles from search show their remote cover; everything else
 * (and any cover that fails to load) uses generated placeholder art.
 * Decorative: the title is rendered by the caller.
 */
export function Cover({ series, className }: { series: CoverSeries; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (series.coverUrl && failedUrl !== series.coverUrl) {
    return (
      // Plain <img>: the image is served straight from the source's CDN, not re-hosted or proxied.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={`cover-img ${className ?? ""}`}
        src={series.coverUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(series.coverUrl ?? null)}
      />
    );
  }
  return <GeneratedCover series={series} className={className} />;
}

function GeneratedCover({ series, className }: { series: CoverSeries; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const rng = createRng(hashString(series.id));
  const h2 = (series.hue + 40 + Math.round(rng() * 30)) % 360;
  const initials = series.title
    .replace(/^the\s+/i, "")
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const shapes = Array.from({ length: 4 }, () => ({
    cx: 60 + rng() * 280,
    cy: 40 + rng() * 380,
    r: 50 + rng() * 120,
    o: 0.1 + rng() * 0.16,
  }));

  return (
    <svg
      className={className}
      viewBox="0 0 400 600"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${series.hue} 55% 36%)`} />
          <stop offset="1" stopColor={`hsl(${h2} 55% 14%)`} />
        </linearGradient>
        <linearGradient id={`${uid}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="400" height="600" fill={`url(#${uid}-bg)`} />
      {shapes.map((s, i) => (
        <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={`hsl(${h2} 70% 75% / ${s.o})`} />
      ))}
      <rect width="400" height="600" fill={`url(#${uid}-fade)`} />
      <text
        x="200"
        y="330"
        textAnchor="middle"
        fontSize="150"
        fontWeight="800"
        fill="hsl(0 0% 100% / 0.88)"
        fontFamily="system-ui, sans-serif"
        letterSpacing="-4"
      >
        {initials}
      </text>
      <rect x="150" y="368" width="100" height="5" rx="2.5" fill="hsl(0 0% 100% / 0.5)" />
    </svg>
  );
}
