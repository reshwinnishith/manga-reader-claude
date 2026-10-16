import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MangaDexReader } from "./mangadex-reader";
import { HomeView } from "./home-view";
import { emptyUserData, saveExternalTitle } from "@/lib/user-data";
import { normalizeMedia } from "@/services/anilist";
import { renderWithApp } from "@/test/helpers";

const id = "12345678-1234-4123-8123-123456789001";
const second = "12345678-1234-4123-8123-123456789002";
const licensedFan = "12345678-1234-4123-8123-123456789003";
const mangaId = "12345678-1234-4123-8123-123456789000";
const title = normalizeMedia({ id: 74347, title: { english: "One-Punch Man" }, status: "FINISHED" }, "now")!;
const initial = () => saveExternalTitle(emptyUserData(), title, "now");
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const release = (chapterId: string, number: string, extra: Record<string, unknown> = {}) => ({
  id: chapterId, number, volume: "", title: "", language: "en", pages: 3, groups: ["Test team"], publishedAt: "2026-01-01", readable: true, ...extra,
});

Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ pageCount: 3, seriesId: title.id, number: "1", group: "Test team", mangaId });
    if (url.includes("/api/sources/mangadex")) return response({ releases: [release(id, "1"), release(second, "2")] });
    return response({ error: "unexpected" }, 500);
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("saves only loaded pages, retries failures, and completes automatically when advancing past final page", async () => {
  const user = userEvent.setup();
  const data = initial(); data.readerModes[title.id] = "paged-rtl";
  const { store } = renderWithApp(<MangaDexReader id={id} group="untrusted query" seriesId={title.id} />, data);
  const first = await screen.findByRole("img", { name: "Page 1" });
  expect(store.getSnapshot()?.progress[title.id]).toBeUndefined();
  fireEvent.load(first);
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({ page: 0, completed: false });
  await user.click(screen.getByRole("button", { name: "Next page" }));
  const page2 = screen.getByRole("img", { name: "Page 2" });
  fireEvent.error(page2);
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]?.page).toBe(0);
  await user.click(screen.getByRole("button", { name: "Retry page 2" }));
  expect(screen.getByRole("img", { name: "Page 2" })).toHaveAttribute("src", expect.stringContaining("retry=1"));
  fireEvent.load(screen.getByRole("img", { name: "Page 2" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.load(screen.getByRole("img", { name: "Page 3" }));
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({ page: 2, completed: false });
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({ page: 2, atEnd: true, completed: true });
  expect(store.getSnapshot()?.library[title.id]?.status).toBe("reading");
  expect(screen.getByText(/Translation: Test team/)).toBeInTheDocument();
});

it("restores scroll position without requesting earlier pages and keeps backup progress", async () => {
  const data = initial();
  data.progress[title.id] = { lastChapterId: id, updatedAt: "now", chapters: { [id]: { page: 1, pageCount: 3, completed: false, atEnd: false, updatedAt: "now" } } };
  const { store, unmount } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);
  await screen.findByRole("img", { name: "Page 2" });
  expect(screen.queryByRole("img", { name: "Page 1" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Show earlier pages/ })).toBeInTheDocument();
  fireEvent.load(screen.getByRole("img", { name: "Page 2" }));
  const snapshot = store.getSnapshot()!;
  expect(snapshot.progress[title.id]?.chapters[id]?.page).toBe(1);
  unmount();
  renderWithApp(<HomeView />, JSON.parse(JSON.stringify(snapshot)));
  expect(screen.getByRole("link", { name: /One-Punch Man.*Resume page 2 of 3/ })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${id}`));
});

it("resolves next chapters from the classified edition feed rather than URL navigation hints", async () => {
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} next={{ id: mangaId, number: "999" }} />, initial());
  expect(await screen.findByRole("link", { name: "Chapter 2 →" })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${second}`));
  expect(screen.queryByRole("link", { name: /999/ })).not.toBeInTheDocument();
  expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining(`/api/sources/mangadex?manga=${mangaId}`), expect.any(Object));
});

it("omits licensed fan uploads from reader previous/next navigation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ pageCount: 3, seriesId: title.id, number: "1", group: "Official", mangaId });
    // Server already withheld the licensed fan upload from `releases`.
    if (url.includes("/api/sources/mangadex")) return response({
      releases: [release(id, "1", { groups: ["Official"] }), release(second, "3", { groups: ["Official"] })],
      hidden: { "licensed-in-english": 1 },
      licensedInEnglish: true,
    });
    return response({ error: "unexpected" }, 500);
  }));
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("link", { name: "Chapter 3 →" })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${second}`));
  expect(screen.queryByRole("link", { name: new RegExp(licensedFan) })).not.toBeInTheDocument();
  expect(screen.queryByText(/Chapter 2/)).not.toBeInTheDocument();
});

it("rejects a chapter belonging to a different edition without recording progress", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ pageCount: 3, seriesId: "al-85364", number: "1", group: "ONE", mangaId })));
  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("alert")).toHaveTextContent("does not belong");
  expect(store.getSnapshot()?.progress).toEqual({});
});

it("shows removed chapter errors and supports a successful retry", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ error: "Chapter removed" }, 502))
    .mockResolvedValueOnce(response({ pageCount: 1, seriesId: title.id, number: "0", group: "Team", mangaId }))
    .mockResolvedValue(response({ releases: [] }));
  vi.stubGlobal("fetch", fetcher);
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("alert")).toHaveTextContent("Chapter removed");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry chapter" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Page 1" })).toBeInTheDocument());
});

it("skips external-only and withheld chapters in previous/next, listing no link-outs", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ pageCount: 3, seriesId: title.id, number: "1", group: "Test team", mangaId });
    if (url.includes("/api/sources/mangadex")) return response({ releases: [
      release(id, "1"),
      release("12345678-1234-4123-8123-123456789010", "2", { readable: false, restriction: "external", externalUrl: "https://publisher.example/2", groups: ["Publisher"] }),
      release("12345678-1234-4123-8123-123456789011", "3", { readable: false, restriction: "unavailable" }),
      release(second, "4"),
    ] });
    return response({ error: "unexpected" }, 500);
  }));
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("link", { name: "Chapter 4 →" })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${second}`));
  expect(screen.queryByRole("link", { name: /publisher|↗/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="https://publisher.example"]')).toBeNull();
});

it("shows one next link when two groups uploaded the same chapter", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ pageCount: 3, seriesId: title.id, number: "1", group: "Test team", mangaId });
    if (url.includes("/api/sources/mangadex")) return response({ releases: [
      release(id, "1"), release("12345678-1234-4123-8123-123456789020", "1", { groups: ["Other team"], publishedAt: "2027-01-01" }),
      release(second, "2"), release("12345678-1234-4123-8123-123456789021", "2", { groups: ["Other team"], publishedAt: "2027-01-01" }),
    ] });
    return response({ error: "unexpected" }, 500);
  }));
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("link", { name: "Chapter 2 →" })).toHaveAttribute("href", expect.stringContaining("/mangadex/read/12345678-1234-4123-8123-123456789021"));
  expect(screen.queryByRole("link", { name: /Chapter 1/ })).not.toBeInTheDocument(); // no repeat of the chapter being read
  expect(screen.getAllByRole("link", { name: /Chapter \d →/ })).toHaveLength(1);
});

it("fails safely on a disallowed chapter URL: no pages requested and no progress saved", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ error: "In-app reading isn't enabled for this title. Use the official link on the title page, if one is listed." }, 502);
    return response({ releases: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("alert")).toHaveTextContent("isn't enabled");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Finish chapter" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/mangadex/page/"))).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/sources/mangadex"))).toBe(false); // navigation feed only loads for an allowed chapter
  expect(store.getSnapshot()?.progress).toEqual({});
  expect(store.getSnapshot()?.library[title.id]?.status).not.toBe("reading");
});

it("displays series title in header and indicates boundary states when on first or latest chapter", async () => {
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByText("One-Punch Man")).toBeInTheDocument();
  expect(screen.getByText("Chapter 1")).toBeInTheDocument();
  expect(await screen.findByText("First chapter")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Chapter 2 →" })).toBeInTheDocument();
});

it("offers continue to next chapter upon finishing and allows retry when navigation fails", async () => {
  const user = userEvent.setup();
  let failNav = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/chapter/")) return response({ pageCount: 3, seriesId: title.id, number: "1", group: "Test team", mangaId });
    if (url.includes("/api/sources/mangadex")) {
      if (failNav) return response({ error: "Network error" }, 500);
      return response({ releases: [release(id, "1"), release(second, "2")] });
    }
    return response({ error: "unexpected" }, 500);
  }));

  const data = initial();
  data.readerModes[title.id] = "paged-rtl";
  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);
  const first = await screen.findByRole("img", { name: "Page 1" });
  fireEvent.load(first);

  expect(await screen.findByText(/Chapter navigation unavailable/)).toBeInTheDocument();
  const retryBtn = screen.getByRole("button", { name: "Retry navigation" });
  failNav = false;
  await user.click(retryBtn);

  expect(await screen.findByRole("link", { name: "Chapter 2 →" })).toBeInTheDocument();

  // Advance to final page in paged mode and load it
  await user.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.load(screen.getByRole("img", { name: "Page 2" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  const lastImg = screen.getByRole("img", { name: "Page 3" });
  fireEvent.load(lastImg);
  await user.click(screen.getByRole("button", { name: "Next page" }));

  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({ page: 2, atEnd: true, completed: true });
  expect(screen.getByRole("link", { name: "Continue to next chapter" })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${second}`));
});

it("supports tap gestures in paged mode: tapping left advances, tapping right goes back", async () => {
  const data = initial();
  data.readerModes[title.id] = "paged-rtl";
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);

  await screen.findByRole("img", { name: "Page 1" });
  const surface = document.querySelector(".source-reader__pages--paged")!;

  // Mock viewport width as 375px
  vi.stubGlobal("innerWidth", 375);

  // Tap on left side (< 35% of 375 = 131px): clientX = 50 -> advances to page 2
  fireEvent.touchStart(surface, { touches: [{ clientX: 50, clientY: 300 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 52, clientY: 301 }] });
  expect(await screen.findByRole("img", { name: "Page 2" })).toBeInTheDocument();

  // Tap on right side (> 65% of 375 = 243px): clientX = 300 -> goes back to page 1
  fireEvent.touchStart(surface, { touches: [{ clientX: 300, clientY: 300 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 298, clientY: 299 }] });
  expect(await screen.findByRole("img", { name: "Page 1" })).toBeInTheDocument();
});

it("ignores tap gestures originating on interactive elements while preserving intentional page-turn taps", async () => {
  const data = initial();
  data.readerModes[title.id] = "paged-rtl";
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);

  const page1 = await screen.findByRole("img", { name: "Page 1" });
  fireEvent.error(page1);

  // An interactive retry button is now present on the page
  const retryBtn = await screen.findByRole("button", { name: "Retry page 1" });
  expect(retryBtn).toBeInTheDocument();

  vi.stubGlobal("innerWidth", 375);

  // Tapping on the retry button (located in the left tap zone) must NOT advance the page
  fireEvent.touchStart(retryBtn, { touches: [{ clientX: 50, clientY: 300 }] });
  fireEvent.touchEnd(retryBtn, { changedTouches: [{ clientX: 50, clientY: 300 }] });

  expect(screen.queryByRole("img", { name: "Page 2" })).not.toBeInTheDocument();
  expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();

  // Intentional tap on non-interactive area advances to page 2
  const surface = document.querySelector(".source-reader__pages--paged")!;
  fireEvent.touchStart(surface, { touches: [{ clientX: 50, clientY: 300 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 50, clientY: 300 }] });

  expect(await screen.findByRole("img", { name: "Page 2" })).toBeInTheDocument();
  expect(screen.getByText("Page 2 / 3")).toBeInTheDocument();
});

it("in vertical scroll mode, loading the final image does not complete until the reader genuinely reaches the final page", async () => {
  const PAGE_H = 600;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });

  let scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;
    if (this.dataset.page !== undefined) return rect(Number(this.dataset.page) * PAGE_H - scrollTop, PAGE_H);
    if (this.id === "source-reader-end") return rect(3 * PAGE_H - scrollTop, 400);
    return rect(0, 0);
  });

  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  await screen.findByRole("img", { name: "Page 1" });
  const page3 = screen.getByRole("img", { name: "Page 3" });

  // Load the final image while the user is still at the top of the chapter (scrollTop = 0, page = 0)
  fireEvent.load(page3);

  // Loading the final image must NOT complete the chapter while at the top
  expect(screen.getByText(/Scroll to the final page/)).toBeInTheDocument();
  expect(store.getSnapshot()?.progress[title.id]).toBeUndefined();

  // Simulate scrolling to the final page (scrollTop = 1200)
  scrollTop = 1200;
  fireEvent.scroll(window);

  // Once genuinely reached and loaded, the chapter completes automatically
  expect(screen.getByText("Chapter complete.")).toBeInTheDocument();
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({ page: 2, atEnd: true, completed: true });
});

it("provides a direct back to series recovery link when chapter fails to load", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Chapter offline" }, 502)));
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());

  expect(await screen.findByRole("alert")).toHaveTextContent("Chapter offline");
  expect(screen.getByRole("button", { name: "Retry chapter" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to series" })).toHaveAttribute("href", `/series/${title.id}`);
});

it("renders Home and Settings controls on right of overlay and supports quick scrubber", async () => {
  const data = initial();
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);

  expect(await screen.findByRole("img", { name: "Page 1" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  expect(screen.getByRole("button", { name: /Switch to paged/ })).toBeInTheDocument();

  const scrubber = screen.getByRole("slider", { name: "Quick page scrubber" });
  expect(scrubber).toBeInTheDocument();
  expect(scrubber).toHaveAttribute("aria-valuenow", "1");
  expect(scrubber).toHaveAttribute("aria-valuemax", "3");
});

it("advancing to next chapter from bottom bar marks the current chapter complete", async () => {
  const user = userEvent.setup();
  const data = initial();
  data.readerModes[title.id] = "paged-rtl";
  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);

  expect(await screen.findByRole("img", { name: "Page 1" })).toBeInTheDocument();
  expect(store.getSnapshot()?.progress[title.id]).toBeUndefined();

  const nextLink = await screen.findByRole("link", { name: "Chapter 2 →" });
  await user.click(nextLink);

  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]).toMatchObject({
    page: 2,
    atEnd: true,
    completed: true,
  });
});

it("single iPhone tap produces exactly one overlay toggle in scroll mode, ignoring synthetic clicks", async () => {
  const data = initial();
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, data);

  await screen.findByRole("img", { name: "Page 1" });
  const surface = document.querySelector(".source-reader__pages")!;
  const readerEl = document.querySelector(".source-reader")!;

  expect(readerEl).toHaveAttribute("data-controls", "visible");

  // Simulate iPhone single tap: touchStart + touchEnd + synthetic click
  fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.click(surface, { clientX: 200, clientY: 300 });

  expect(readerEl).toHaveAttribute("data-controls", "hidden");

  // Second iPhone single tap: toggles back to visible
  fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.click(surface, { clientX: 200, clientY: 300 });

  expect(readerEl).toHaveAttribute("data-controls", "visible");
});

it("quick scrubbing to the final page in scroll mode does not automatically mark chapter complete", async () => {
  const PAGE_H = 600;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("quick-scrubber__hit-area")) return rect(100, 400);
    if (this.dataset.page !== undefined) return rect(Number(this.dataset.page) * PAGE_H, PAGE_H);
    if (this.id === "source-reader-end") return rect(3 * PAGE_H, 400);
    return rect(0, 0);
  });

  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  await screen.findByRole("img", { name: "Page 1" });

  const scrubber = screen.getByRole("slider", { name: "Quick page scrubber" });

  // Quick scrub to the final page (page 3, index 2)
  fireEvent.pointerDown(scrubber, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(scrubber, { clientY: 500, pointerId: 1 });
  fireEvent.pointerUp(scrubber, { clientY: 500, pointerId: 1 });

  // Must update indicator to Page 3 / 3
  expect(screen.getByText("Page 3 / 3")).toBeInTheDocument();

  // Scrubbing to final page must NOT mark the chapter completed
  expect(store.getSnapshot()?.progress[title.id]?.chapters[id]?.completed).toBeFalsy();
  expect(screen.getByText(/Scroll to the final page to complete/)).toBeInTheDocument();
});

