/**
 * Pure position maths for the vertical reader, kept free of the DOM so the
 * completion boundary can be unit-tested.
 *
 * The reader tracks a single `index` per chapter: 0..pageCount-1 are pages and
 * `pageCount` means "the end of the chapter".
 */

/** The current page is the one under this line (fraction of viewport height from the top). */
export const REFERENCE_LINE = 0.25;
/** The chapter is "at its end" once the final page's bottom edge passes this line. */
export const END_LINE = 0.5;

export interface VerticalMeasure {
  /** Top edge of every page, in the same coordinate space as `viewportTop`. */
  pageTops: number[];
  /** Top edge of the end card (= bottom edge of the final page). */
  endTop: number;
  viewportTop: number;
  viewportHeight: number;
}

export function pickVerticalIndex({ pageTops, endTop, viewportTop, viewportHeight }: VerticalMeasure): number {
  const pageCount = pageTops.length;
  if (pageCount === 0) return 0;
  if (endTop <= viewportTop + viewportHeight * END_LINE) return pageCount;
  const line = viewportTop + viewportHeight * REFERENCE_LINE;
  let index = 0;
  for (let i = 0; i < pageCount; i++) {
    if (pageTops[i]! <= line) index = i;
    else break;
  }
  return index;
}

/** Page to record for an index: the end of the chapter is stored as the final page. */
export const pageForIndex = (index: number, pageCount: number) => Math.max(0, Math.min(index, pageCount - 1));
export const isEndIndex = (index: number, pageCount: number) => index >= pageCount;
