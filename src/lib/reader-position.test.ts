import { describe, expect, it } from "vitest";
import { isEndIndex, pageForIndex, pickVerticalIndex } from "./reader-position";

// 5 pages of 600px, viewport 800px tall. Page i starts at i*600 - scrollTop.
const PAGE = 600;
const measure = (scrollTop: number, pages = 5, vh = 800) => ({
  pageTops: Array.from({ length: pages }, (_, i) => i * PAGE - scrollTop),
  endTop: pages * PAGE - scrollTop,
  viewportTop: 0,
  viewportHeight: vh,
});

describe("pickVerticalIndex", () => {
  it("picks the page under the reference line (25% down the viewport)", () => {
    expect(pickVerticalIndex(measure(0))).toBe(0);
    expect(pickVerticalIndex(measure(300))).toBe(0); // page 1 starts at 300 > line (200)
    expect(pickVerticalIndex(measure(450))).toBe(1); // page 1 top at 150 <= 200
    expect(pickVerticalIndex(measure(1200))).toBe(2); // exactly aligned to a page top
  });

  it("restoring a page by aligning its top reproduces the same page (stable round trip)", () => {
    for (let page = 0; page < 5; page++) {
      expect(pickVerticalIndex(measure(page * PAGE))).toBe(page);
    }
  });

  it("does NOT treat sitting on the final page as the end of the chapter", () => {
    const lastPageTop = 4 * PAGE;
    expect(pickVerticalIndex(measure(lastPageTop))).toBe(4);
    // Even with the bottom of the last page well in view (but below mid-screen).
    expect(pickVerticalIndex(measure(lastPageTop + 150))).toBe(4);
  });

  it("reaches the end exactly when the final page's bottom edge passes mid-screen", () => {
    const endAtMid = 5 * PAGE - 400; // endTop == 400 == 50% of 800
    expect(pickVerticalIndex(measure(endAtMid))).toBe(5);
    expect(pickVerticalIndex(measure(endAtMid - 1))).toBe(4); // one pixel short
  });

  it("scrolling back up leaves the end and returns to the right page", () => {
    expect(pickVerticalIndex(measure(5 * PAGE))).toBe(5);
    expect(pickVerticalIndex(measure(4 * PAGE + 100))).toBe(4);
    expect(pickVerticalIndex(measure(3 * PAGE))).toBe(3);
  });

  it("handles a viewport taller than a page and empty chapters", () => {
    expect(pickVerticalIndex(measure(0, 1, 2000))).toBe(1); // one short page, fully past mid-screen
    expect(pickVerticalIndex({ pageTops: [], endTop: 0, viewportTop: 0, viewportHeight: 800 })).toBe(0);
  });
});

describe("index helpers", () => {
  it("stores the end of a chapter as its final page", () => {
    expect(pageForIndex(5, 5)).toBe(4);
    expect(pageForIndex(2, 5)).toBe(2);
    expect(pageForIndex(-1, 5)).toBe(0);
    expect(isEndIndex(5, 5)).toBe(true);
    expect(isEndIndex(4, 5)).toBe(false);
  });
});
