import { useId } from "react";
import { PAGE_H, PAGE_W, createRng, hashString, layoutPanels } from "@/lib/placeholder";

interface PlaceholderPageProps {
  seriesId: string;
  hue: number;
  chapterNumber: number;
  /** 0-based */
  page: number;
  pageCount: number;
  /** Webtoon-style single column with big gutters. */
  strip?: boolean;
  className?: string;
}

/**
 * A fully local, generated stand-in for a manga page: abstract panels in the
 * series' colour. Deterministic per series/chapter/page, so it is stable
 * across renders and needs no network or image files.
 */
export function PlaceholderPage({
  seriesId,
  hue,
  chapterNumber,
  page,
  pageCount,
  strip = false,
  className,
}: PlaceholderPageProps) {
  const uid = useId().replace(/:/g, "");
  const rng = createRng(hashString(`${seriesId}:${chapterNumber}:${page}`));
  const panels = layoutPanels(rng, strip);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
      role="img"
      aria-label={`Placeholder page ${page + 1} of ${pageCount}, chapter ${chapterNumber}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect width={PAGE_W} height={PAGE_H} fill={`hsl(${hue} 22% 11%)`} />
      {panels.map((p, i) => {
        const h1 = (hue + Math.round(rng() * 50) - 25 + 360) % 360;
        const h2 = (h1 + 30 + Math.round(rng() * 40)) % 360;
        const angle = Math.round(rng() * 360);
        const id = `${uid}-g${i}`;
        const cx = p.x + p.w * (0.25 + rng() * 0.5);
        const cy = p.y + p.h * (0.25 + rng() * 0.5);
        const r = Math.min(p.w, p.h) * (0.18 + rng() * 0.22);
        return (
          <g key={i}>
            <defs>
              <linearGradient id={id} gradientTransform={`rotate(${angle} .5 .5)`}>
                <stop offset="0" stopColor={`hsl(${h1} 45% 30%)`} />
                <stop offset="1" stopColor={`hsl(${h2} 50% 17%)`} />
              </linearGradient>
              <clipPath id={`${id}c`}>
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={6} />
              </clipPath>
            </defs>
            <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={6} fill={`url(#${id})`} />
            <g clipPath={`url(#${id}c)`}>
              <circle cx={cx} cy={cy} r={r} fill={`hsl(${h2} 60% 62% / 0.22)`} />
              <circle cx={cx} cy={cy} r={r * 0.55} fill={`hsl(${h1} 70% 70% / 0.18)`} />
              {Array.from({ length: 5 }, (_, k) => (
                <line
                  key={k}
                  x1={p.x - 20}
                  y1={p.y + p.h * ((k + 1) / 6)}
                  x2={p.x + p.w + 20}
                  y2={p.y + p.h * ((k + 1) / 6) - p.h * 0.18}
                  stroke={`hsl(${h2} 40% 80% / 0.07)`}
                  strokeWidth={4}
                />
              ))}
            </g>
            <rect
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              rx={6}
              fill="none"
              stroke="hsl(0 0% 100% / 0.22)"
              strokeWidth={3}
            />
          </g>
        );
      })}
      <text
        x={PAGE_W - 52}
        y={PAGE_H - 44}
        textAnchor="end"
        fontSize={34}
        fontWeight={700}
        fill="hsl(0 0% 100% / 0.55)"
        fontFamily="system-ui, sans-serif"
      >
        {page + 1}
      </text>
      <text
        x={52}
        y={PAGE_H - 46}
        fontSize={22}
        fill="hsl(0 0% 100% / 0.35)"
        fontFamily="system-ui, sans-serif"
        letterSpacing={2}
      >
        {`PLACEHOLDER · CH ${chapterNumber}`}
      </text>
    </svg>
  );
}
