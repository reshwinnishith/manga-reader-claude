/** Deterministic helpers for generating local placeholder artwork. */

export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: small, fast, deterministic. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PAGE_W = 800;
export const PAGE_H = 1200;

/**
 * Recursively split a rect into panels. `verticalOnly` produces a webtoon-like
 * single column of stacked panels.
 */
export function layoutPanels(rng: () => number, verticalOnly: boolean): Rect[] {
  const gutter = verticalOnly ? 36 : 22;
  const margin = verticalOnly ? 40 : 36;
  const root: Rect = { x: margin, y: margin, w: PAGE_W - margin * 2, h: PAGE_H - margin * 2 };

  const split = (r: Rect, depth: number): Rect[] => {
    const minSide = verticalOnly ? 220 : 260;
    const canH = r.h > minSide * 2 + gutter;
    const canV = !verticalOnly && r.w > minSide * 2 + gutter;
    if (depth >= (verticalOnly ? 2 : 3) || (!canH && !canV) || (depth > 0 && rng() < 0.25)) return [r];
    const horizontal = verticalOnly || (canH && (!canV || rng() < 0.55));
    const ratio = 0.35 + rng() * 0.3;
    if (horizontal) {
      const h1 = Math.round((r.h - gutter) * ratio);
      return [
        ...split({ ...r, h: h1 }, depth + 1),
        ...split({ ...r, y: r.y + h1 + gutter, h: r.h - h1 - gutter }, depth + 1),
      ];
    }
    const w1 = Math.round((r.w - gutter) * ratio);
    return [
      ...split({ ...r, w: w1 }, depth + 1),
      ...split({ ...r, x: r.x + w1 + gutter, w: r.w - w1 - gutter }, depth + 1),
    ];
  };

  const panels = split(root, 0);
  // Manga reads right-to-left: order is irrelevant visually, so just return them.
  return panels;
}
