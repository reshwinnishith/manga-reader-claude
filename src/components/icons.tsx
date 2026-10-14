import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
  ...props,
});

export const HomeIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>
);
export const LibraryIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M5 4v16M9.5 4v16" /><path d="m14 5.5 4.6-1.2 1.9 14.7-4.6 1.2z" /></svg>
);
export const DiscoverIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></svg>
);
export const BackIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m15 5-7 7 7 7" /></svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m9 5 7 7-7 7" /></svg>
);
export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const PlayIcon = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
);
export const SwapIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" /></svg>
);
export const PagedIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M12 3.5v17" /></svg>
);
export const ScrollIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="6" y="3.5" width="12" height="17" rx="2" /><path d="M6 9.5h12M6 14.5h12" /></svg>
);
export const SkipPrevIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M6 5v14M19 5l-9 7 9 7z" /></svg>
);
export const SkipNextIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M18 5v14M5 5l9 7-9 7z" /></svg>
);
export const SortIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M8 5v14M8 19l-3-3M8 19l3-3M16 19V5M16 5l-3 3M16 5l3 3" /></svg>
);
export const AlertIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3 2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" /></svg>
);
