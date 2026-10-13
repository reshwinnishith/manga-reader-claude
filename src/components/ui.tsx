import Link from "next/link";
import type { ReactNode } from "react";
import type { Series } from "@/domain/types";
import { Cover } from "./cover";
import { AlertIcon } from "./icons";

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Reading progress"}
    >
      <div className="progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}

export function SectionHeader({ title, action, id }: { title: string; action?: ReactNode; id?: string }) {
  return (
    <div className="section-header">
      <h2 id={id}>{title}</h2>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="empty" role="status">
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action && (
        <Link href={action.href} className="btn btn--primary">
          {action.label}
        </Link>
      )}
    </div>
  );
}

export function ErrorState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty empty--error" role="alert">
      <AlertIcon width={32} height={32} />
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  );
}

export function TypeBadge({ type }: { type: Series["type"] }) {
  return <span className={`badge badge--${type}`}>{type === "manga" ? "Manga" : "Manhwa"}</span>;
}

/** Cover + title card linking to the series page. */
export function SeriesCard({ series, caption, badge }: { series: Series; caption?: string; badge?: ReactNode }) {
  return (
    <Link href={`/series/${series.id}`} className="card">
      <div className="card__cover">
        <Cover series={series} />
        {badge && <span className="card__badge">{badge}</span>}
      </div>
      <span className="card__title">{series.title}</span>
      <span className="card__caption">{caption ?? series.genres.join(" · ")}</span>
    </Link>
  );
}

export function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card">
          <div className="card__cover skeleton" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line skeleton--short" />
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ height = 180 }: { height?: number }) {
  return <div className="skeleton" style={{ height, borderRadius: 20 }} aria-busy="true" aria-label="Loading" />;
}
