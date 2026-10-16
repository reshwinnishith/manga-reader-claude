import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import type { Series, UserData } from "@/domain/types";
import { getResumeTarget } from "@/lib/selectors";
import { addToLibrary, emptyUserData, recordProgress, setReaderMode } from "@/lib/user-data";
import { getSeries, renderWithApp } from "@/test/helpers";
import { ReaderView } from "./reader-view";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

// jsdom has no layout engine.
Element.prototype.scrollIntoView = () => {};

const manga = getSeries("neon-ronin"); // paged right-to-left by default
const manhwa = getSeries("last-cartographer"); // vertical by default
const finished = getSeries("glass-garden"); // publication complete

type Rendered = ReturnType<typeof renderWithApp>;
const chapterProgress = (r: Rendered, s: Series, n: number) =>
  r.store.getSnapshot()?.progress[s.id]?.chapters[`${s.id}-c${n}`];
const resume = (r: Rendered, s: Series) => getResumeTarget(s, r.store.getSnapshot()?.progress[s.id])!;
const pageLabel = (n: number, total: number) => new RegExp(`page ${n} of ${total}`, "i");

beforeEach(() => router.push.mockClear());
afterEach(() => vi.restoreAllMocks());

/** Controls auto-hide while reading; reveal them (like a user would) before using them. */
async function showControls(user: ReturnType<typeof userEvent.setup>) {
  const reveal = screen.queryByRole("button", { name: "Show controls" });
  if (reveal) await user.click(reveal);
}

async function tapNext(user: ReturnType<typeof userEvent.setup>, times: number) {
  for (let i = 0; i < times; i++) await user.click(screen.getByRole("button", { name: "Next page" }));
}

describe("Reader · paged right-to-left (manga)", () => {
  const c1 = manga.chapters[0]!;
  const last = c1.pageCount;

  it("opens on page 1, advances with the left tap zone and goes back with the right", async () => {
    const user = userEvent.setup();
    const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    expect(screen.getByRole("img", { name: pageLabel(1, last) })).toBeInTheDocument();
    await tapNext(user, 2);
    expect(screen.getByRole("img", { name: pageLabel(3, last) })).toBeInTheDocument();
    expect(chapterProgress(r, manga, 1)?.page).toBe(2);
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(chapterProgress(r, manga, 1)?.page).toBe(1);
  });

  it("supports keyboard navigation in reading direction (left arrow = next)", async () => {
    const user = userEvent.setup();
    const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowRight}");
    expect(chapterProgress(r, manga, 1)?.page).toBe(1);
  });

  it("supports keyboard navigation with PageDown and PageUp keys", async () => {
    const user = userEvent.setup();
    const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    await user.keyboard("{PageDown}{PageDown}{PageUp}");
    expect(chapterProgress(r, manga, 1)?.page).toBe(1);
  });

  it("turns pages with swipes: right = next, left = back, mostly-vertical swipes ignored", () => {
    const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    const surface = document.querySelector(".reader__paged")!;
    const swipe = (dx: number, dy = 0) => {
      fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
    };
    swipe(120);
    swipe(120);
    expect(chapterProgress(r, manga, 1)?.page).toBe(2);
    swipe(-120);
    expect(chapterProgress(r, manga, 1)?.page).toBe(1);
    swipe(30); // too short
    swipe(120, 200); // mostly vertical
    expect(chapterProgress(r, manga, 1)?.page).toBe(1);
  });

  it("toggles controls from the centre zone", async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    const root = container.querySelector(".reader")!;
    expect(root).toHaveAttribute("data-controls", "visible");
    await user.click(screen.getByRole("button", { name: "Show or hide controls" }));
    expect(root).toHaveAttribute("data-controls", "hidden");
    await user.click(screen.getByRole("button", { name: "Show or hide controls" }));
    expect(root).toHaveAttribute("data-controls", "visible");
  });

  describe("end-of-chapter completion", () => {
    it("does NOT complete the chapter on the final page; resume stays there", async () => {
      const user = userEvent.setup();
      const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last - 1);
      expect(screen.getByRole("img", { name: pageLabel(last, last) })).toBeInTheDocument();
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: last - 1, atEnd: false, completed: false });
      expect(resume(r, manga)).toMatchObject({ page: last - 1, kind: "continue" });
      expect(resume(r, manga).chapter.id).toBe(c1.id);
    });

    it("completes the chapter when the end card is reached and then resumes in the next chapter", async () => {
      const user = userEvent.setup();
      const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last);
      expect(screen.getByText("Ch. 1 complete")).toBeInTheDocument();
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: last - 1, atEnd: true, completed: true });
      expect(resume(r, manga).chapter.id).toBe(manga.chapters[1]!.id);
      expect(screen.getByRole("link", { name: "Continue to next chapter" })).toHaveAttribute(
        "href",
        `/read/${manga.id}/${manga.chapters[1]!.id}`,
      );
    });

    it("stepping back off the end card clears 'at end' but keeps the chapter completed", async () => {
      const user = userEvent.setup();
      const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last);
      await user.click(screen.getByRole("button", { name: "Back to last page" }));
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: last - 1, atEnd: false, completed: true });
      expect(resume(r, manga).chapter.id).toBe(c1.id);
      expect(resume(r, manga).kind).toBe("continue");
    });

    it("the slider can never complete a chapter", () => {
      const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      const slider = screen.getByRole("slider", { name: "Page" });
      expect(slider).toHaveAttribute("max", String(last - 1));
      fireEvent.change(slider, { target: { value: String(last - 1) } });
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: last - 1, completed: false });
    });
  });

  describe("chapter continuation", () => {
    it("tapping forward on the end card continues to the next chapter (after a short grace period)", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const user = userEvent.setup();
      renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last);

      now += 1_000;
      await user.click(screen.getByRole("button", { name: "Next chapter" }));
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith(`/read/${manga.id}/${manga.chapters[1]!.id}`);
    });

    it("an immediate extra tap or swipe on arriving at the end card does NOT skip the chapter", async () => {
      vi.spyOn(Date, "now").mockReturnValue(5_000_000);
      const user = userEvent.setup();
      renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last); // last tap lands on the end card
      await user.click(screen.getByRole("button", { name: "Next chapter" })); // double tap
      fireEvent.touchStart(document.querySelector(".reader__paged")!, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchEnd(document.querySelector(".reader__paged")!, { changedTouches: [{ clientX: 260, clientY: 300 }] });
      await user.keyboard("{ArrowLeft}");
      expect(router.push).not.toHaveBeenCalled();
    });

    it("the explicit Continue button and footer skip control always work", async () => {
      const user = userEvent.setup();
      renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      expect(screen.getByRole("link", { name: /Next chapter, Ch\. 2/ })).toHaveAttribute("href", `/read/${manga.id}/${manga.chapters[1]!.id}`);
      await tapNext(user, last);
      expect(screen.getByRole("link", { name: "Continue to next chapter" })).toBeVisible();
    });

    it("keeps manual previous/next chapter links in the controls", () => {
      renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[1]!.id} />, emptyUserData());
      expect(screen.getByRole("link", { name: /Previous chapter, Ch\. 1/ })).toHaveAttribute("href", `/read/${manga.id}/${manga.chapters[0]!.id}`);
      expect(screen.getByRole("link", { name: /Next chapter, Ch\. 3/ })).toHaveAttribute("href", `/read/${manga.id}/${manga.chapters[2]!.id}`);
    });

    it("opening the next chapter starts at its top and leaves the finished one completed (no duplicate completion)", async () => {
      const user = userEvent.setup();
      const first = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
      await tapNext(user, last);
      const after: UserData = first.store.getSnapshot()!;
      first.unmount();

      const second = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[1]!.id} />, after);
      expect(screen.getByRole("img", { name: pageLabel(1, manga.chapters[1]!.pageCount) })).toBeInTheDocument();
      expect(chapterProgress(second, manga, 1)).toMatchObject({ completed: true, atEnd: true });
      expect(chapterProgress(second, manga, 2)).toMatchObject({ page: 0, completed: false });
      expect(second.store.getSnapshot()?.progress[manga.id]?.lastChapterId).toBe(manga.chapters[1]!.id);
    });

    it("on the latest chapter, shows a caught-up state with no way forward", async () => {
      const user = userEvent.setup();
      const lastChapter = manga.chapters.at(-1)!;
      renderWithApp(<ReaderView series={manga} chapterId={lastChapter.id} />, emptyUserData());
      await tapNext(user, lastChapter.pageCount);
      expect(screen.getByText("You’re all caught up")).toBeInTheDocument();
      expect(screen.getByText(/New chapters will show up on Home/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Continue to next chapter" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next chapter" })).toBeDisabled();
      expect(screen.getByRole("link", { name: "Back to series" })).toBeInTheDocument();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("on the final chapter of a finished series, says the series is finished", async () => {
      const user = userEvent.setup();
      const lastChapter = finished.chapters.at(-1)!;
      renderWithApp(<ReaderView series={finished} chapterId={lastChapter.id} />, emptyUserData());
      await tapNext(user, lastChapter.pageCount);
      expect(screen.getByText("The end")).toBeInTheDocument();
      expect(screen.getByText(/You’ve finished Glass Garden/)).toBeInTheDocument();
    });
  });

  describe("restoring position and rereading", () => {
    it("restores the saved page when reopening a chapter", () => {
      renderWithApp(<ReaderView series={getSeries("skyward-lanterns")} chapterId="skyward-lanterns-c9" />, createDemoUserData());
      expect(screen.getByRole("img", { name: /page 7 of/i })).toBeInTheDocument();
    });

    it("reopens a chapter that was left on its final page (not finished) on that page", () => {
      const seeded = recordProgress(emptyUserData(), manga, c1.id, last - 1, "2026-10-12T00:00:00Z");
      renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, seeded);
      expect(screen.getByRole("img", { name: pageLabel(last, last) })).toBeInTheDocument();
    });

    it("reopens a chapter that was left at its end from the top, and keeps it marked completed while rereading", async () => {
      const user = userEvent.setup();
      const seeded = recordProgress(emptyUserData(), manga, c1.id, last - 1, "2026-10-12T00:00:00Z", true);
      const r = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, seeded);
      expect(screen.getByRole("img", { name: pageLabel(1, last) })).toBeInTheDocument();
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 0, atEnd: false, completed: true });
      await tapNext(user, 3);
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 3, atEnd: false, completed: true });
      expect(resume(r, manga)).toMatchObject({ page: 3 });
      expect(resume(r, manga).chapter.id).toBe(c1.id);
    });
  });
});

// ---------------------------------------------------------------------------

describe("Reader · vertical scroll (manhwa)", () => {
  const c1 = manhwa.chapters[0]!;
  const n = c1.pageCount;
  const PAGE_H = 585; // 390px wide * 1.5
  const VIEW_H = 844;

  /** Fake layout: page i spans [i*PAGE_H - scrollTop, ...], end card starts at n*PAGE_H - scrollTop. */
  function scrollTo(scrollTop: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;
      if (this.classList.contains("reader__scroll")) return rect(0, VIEW_H);
      if (this.dataset.page !== undefined) return rect(Number(this.dataset.page) * PAGE_H - scrollTop, PAGE_H);
      if (this.id === "reader-end") return rect(n * PAGE_H - scrollTop, 600);
      return rect(0, 0);
    });
    fireEvent.scroll(document.querySelector(".reader__scroll")!);
  }
  const lastPageTop = (n - 1) * PAGE_H;
  const endMid = n * PAGE_H - VIEW_H / 2; // scrollTop where the final page's bottom hits mid-screen

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to vertical for manhwa and renders every page in one scroll", () => {
    const { container } = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
    expect(container.querySelector(".reader")).toHaveAttribute("data-mode", "vertical");
    expect(container.querySelectorAll(".vpage")).toHaveLength(n);
    expect(screen.getByRole("link", { name: "Continue to next chapter" })).toBeInTheDocument();
  });

  it("tracks the current page while scrolling and saves it", () => {
    const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
    scrollTo(3 * PAGE_H);
    expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: 3, completed: false });
    scrollTo(5 * PAGE_H + 100);
    expect(chapterProgress(r, manhwa, 1)?.page).toBe(5);
  });

  describe("end-of-chapter completion", () => {
    it("does NOT complete while on the final page, even with its bottom visible", () => {
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      scrollTo(lastPageTop);
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: n - 1, atEnd: false, completed: false });
      scrollTo(endMid - 1); // one pixel short of the boundary
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: n - 1, atEnd: false, completed: false });
      expect(resume(r, manhwa).chapter.id).toBe(c1.id);
    });

    it("completes exactly when the final page's bottom edge passes mid-screen", () => {
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      scrollTo(endMid);
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: n - 1, atEnd: true, completed: true });
      expect(resume(r, manhwa).chapter.id).toBe(manhwa.chapters[1]!.id);
    });

    it("jumping straight to the end in one scroll event still completes", () => {
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      scrollTo(n * PAGE_H);
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ atEnd: true, completed: true });
    });

    it("scrolling back up clears 'at end' but keeps the chapter completed; resume returns to the page", () => {
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      scrollTo(n * PAGE_H);
      scrollTo(lastPageTop);
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: n - 1, atEnd: false, completed: true });
      scrollTo(4 * PAGE_H);
      expect(chapterProgress(r, manhwa, 1)).toMatchObject({ page: 4, atEnd: false, completed: true });
      expect(resume(r, manhwa)).toMatchObject({ page: 4 });
      expect(resume(r, manhwa).chapter.id).toBe(c1.id);
    });

    it("repeated scroll events at the same position cause no extra writes (no duplicate completion)", () => {
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      scrollTo(n * PAGE_H);
      const listener = vi.fn();
      r.store.subscribe(listener);
      scrollTo(n * PAGE_H);
      scrollTo(n * PAGE_H + 20);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it("toggles controls when tapping a page", async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
    const root = container.querySelector(".reader")!;
    await user.click(container.querySelector(".vpage")!);
    expect(root).toHaveAttribute("data-controls", "hidden");
    await user.click(screen.getByRole("button", { name: "Show controls" }));
    expect(root).toHaveAttribute("data-controls", "visible");
  });

  describe("reading mode", () => {
    it("remembers the mode per series", async () => {
      const user = userEvent.setup();
      const r = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
      await user.click(screen.getByRole("button", { name: /Switch to paged/ }));
      expect(r.store.getSnapshot()?.readerModes[manhwa.id]).toBe("paged-rtl");
      expect(r.container.querySelector(".reader")).toHaveAttribute("data-mode", "paged-rtl");
      expect(r.store.getSnapshot()?.readerModes[manga.id]).toBeUndefined();
    });

    it("uses a stored per-series mode on open", () => {
      const stored = setReaderMode(emptyUserData(), manga.id, "vertical");
      const { container } = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, stored);
      expect(container.querySelector(".reader")).toHaveAttribute("data-mode", "vertical");
    });

    it("keeps the current page when switching paged -> vertical -> paged, without touching completion", async () => {
      const user = userEvent.setup();
      const r = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
      await tapNext(user, 3);
      await act(async () => r.store.setReaderMode(manga.id, "vertical"));
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 3, atEnd: false, completed: false });
      await act(async () => r.store.setReaderMode(manga.id, "paged-rtl"));
      expect(screen.getByRole("img", { name: /page 4 of/i })).toBeInTheDocument();
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 3, completed: false });
    });

    it("switching modes on the final page does not complete the chapter", async () => {
      const user = userEvent.setup();
      const m = manga.chapters[0]!;
      const r = renderWithApp(<ReaderView series={manga} chapterId={m.id} />, emptyUserData());
      await tapNext(user, m.pageCount - 1);
      await showControls(user);
      await user.click(screen.getByRole("button", { name: /Switch to vertical/ }));
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: m.pageCount - 1, atEnd: false, completed: false });
      await showControls(user);
      await user.click(screen.getByRole("button", { name: /Switch to paged/ }));
      expect(chapterProgress(r, manga, 1)).toMatchObject({ atEnd: false, completed: false });
    });

    it("keeps 'at end' consistent across modes in both directions", async () => {
      const user = userEvent.setup();
      const m = manga.chapters[0]!;
      const r = renderWithApp(<ReaderView series={manga} chapterId={m.id} />, emptyUserData());
      await tapNext(user, m.pageCount); // paged end card
      expect(chapterProgress(r, manga, 1)).toMatchObject({ atEnd: true, completed: true });
      await showControls(user);
      await user.click(screen.getByRole("button", { name: /Switch to vertical/ }));
      expect(r.container.querySelector(".reader")).toHaveAttribute("data-at-end", "true");
      expect(chapterProgress(r, manga, 1)).toMatchObject({ atEnd: true, completed: true });

      // Scroll back up in vertical mode, then switch to paged: not at end, still completed.
      const pageH = 585;
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 1));
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;
        if (this.classList.contains("reader__scroll")) return rect(0, 844);
        if (this.dataset.page !== undefined) return rect(Number(this.dataset.page) * pageH - 2 * pageH, pageH);
        if (this.id === "reader-end") return rect(m.pageCount * pageH - 2 * pageH, 600);
        return rect(0, 0);
      });
      fireEvent.scroll(document.querySelector(".reader__scroll")!);
      expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 2, atEnd: false, completed: true });
      await showControls(user);
      await user.click(screen.getByRole("button", { name: /Switch to paged/ }));
      expect(screen.getByRole("img", { name: /page 3 of/i })).toBeInTheDocument();
      expect(chapterProgress(r, manga, 1)).toMatchObject({ atEnd: false, completed: true });
    });
  });
});

describe("Reader · errors and setup", () => {
  it("shows a recoverable message for an unknown chapter", () => {
    renderWithApp(<ReaderView series={manga} chapterId="nope" />, emptyUserData());
    expect(screen.getByRole("alert")).toHaveTextContent("could not be found");
    expect(screen.getByRole("link", { name: "Back to series" })).toHaveAttribute("href", `/series/${manga.id}`);
  });

  it("locks page scrolling behind the reader only while it is open", () => {
    const r = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    expect(document.documentElement).toHaveClass("reader-open");
    r.unmount();
    expect(document.documentElement).not.toHaveClass("reader-open");
  });

  it("opening a chapter of a dropped series puts it back to reading", () => {
    const dropped = addToLibrary(emptyUserData(), manga.id, "2026-10-12T00:00:00Z", "dropped");
    const r = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, dropped);
    expect(r.store.getSnapshot()?.library[manga.id]?.status).toBe("reading");
  });

  it("exposes accessible region labels for keyboard and assistive navigation", () => {
    const rPaged = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    expect(screen.getByRole("region", { name: /Neon Ronin.*page 1 of 16/i })).toBeInTheDocument();
    rPaged.unmount();

    renderWithApp(<ReaderView series={manhwa} chapterId={manhwa.chapters[0]!.id} />, emptyUserData());
    expect(screen.getByRole("region", { name: /The Last Cartographer.*continuous scroll/i })).toBeInTheDocument();
  });
});

describe("Reader v1.1 · Navigation overlay, Quick scrubber & Auto-progress", () => {
  it("renders Home and Settings controls on the right of the top overlay", () => {
    renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /Switch to vertical/ })).toBeInTheDocument();
  });

  it("scrubbing first, middle and last pages updates position without falsely completing", () => {
    const r = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    const scrubber = screen.getByRole("slider", { name: "Quick page scrubber" });

    vi.spyOn(scrubber, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 500,
      height: 400,
      left: 10,
      right: 54,
      width: 44,
      x: 10,
      y: 100,
      toJSON: () => {},
    });

    // Scrub to middle (fraction 0.5 -> page 8 of 16)
    fireEvent.pointerDown(scrubber, { clientY: 300, pointerId: 1 });
    expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 8, completed: false, atEnd: false });

    // Scrub to last page (fraction 1.0 -> page 15)
    fireEvent.pointerMove(scrubber, { clientY: 500, pointerId: 1 });
    expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 15, completed: false, atEnd: false });

    // Scrub back to first page (fraction 0 -> page 0)
    fireEvent.pointerMove(scrubber, { clientY: 100, pointerId: 1 });
    expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 0, completed: false, atEnd: false });
  });

  it("advancing to next chapter from footer automatically marks previous chapter complete", async () => {
    const user = userEvent.setup();
    const r = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    expect(chapterProgress(r, manga, 1)).toMatchObject({ page: 0, completed: false });

    const nextBtn = screen.getByRole("link", { name: /Next chapter, Ch\. 2/ });
    await user.click(nextBtn);

    // Current chapter is now marked completed
    expect(chapterProgress(r, manga, 1)).toMatchObject({ completed: true, atEnd: true });
  });

  it("quick scrubber is visible when controls are visible and hidden when controls are hidden", async () => {
    const user = userEvent.setup();
    renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());

    const scrubberAside = screen.getByLabelText("Page scrubber");
    expect(scrubberAside).toHaveClass("quick-scrubber--visible");

    // Toggle controls off
    await user.click(screen.getByRole("button", { name: "Show or hide controls" }));
    expect(scrubberAside).toHaveClass("quick-scrubber--hidden");
    expect(scrubberAside).toHaveAttribute("aria-hidden", "true");

    // Toggle controls on
    await user.click(screen.getByRole("button", { name: "Show or hide controls" }));
    expect(scrubberAside).toHaveClass("quick-scrubber--visible");
    expect(scrubberAside).toHaveAttribute("aria-hidden", "false");
  });
});

