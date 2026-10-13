const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** ISO date/timestamp -> "Oct 8, 2026" (UTC, so server and client agree). */
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

export const formatChapterNumber = (n: number) => `Ch. ${n}`;

export const pluralize = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Ch. 5 · The Drifting Market", or just "Ch. 5" when the title is the generic "Chapter 5". */
export function formatChapterLabel(chapter: { number: number; title: string }): string {
  const generic = chapter.title.trim().toLowerCase() === `chapter ${chapter.number}`;
  return generic ? formatChapterNumber(chapter.number) : `${formatChapterNumber(chapter.number)} · ${chapter.title}`;
}
