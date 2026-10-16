import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MangaDexChapters } from "./mangadex-chapters";
import { SeriesView } from "./series-view";
import { emptyUserData, saveExternalTitle } from "@/lib/user-data";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { normalizeMedia } from "@/services/anilist";
import { clearReadingSourceCache } from "@/services/reading-sources";
import { renderWithApp } from "@/test/helpers";

const chapterId = "12345678-1234-4123-8123-123456789001";
const mangaId = "12345678-1234-4123-8123-123456789000";
const title = normalizeMedia({
  id: 31668,
  title: { english: "Give My Regards to Black Jack" },
  status: "FINISHED",
  siteUrl: "https://anilist.co/manga/31668",
}, "now")!;
const opm = normalizeMedia({ id: 74347, title: { english: "One-Punch Man" }, status: "FINISHED", siteUrl: "https://anilist.co/manga/74347" }, "now")!;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  clearReadingSourceCache();
  vi.unstubAllGlobals();
});

it("lists readable chapters and links into the in-app reader", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({
    status: "verified",
    mangaId,
    officialLinks: [],
    licensedInEnglish: false,
    hidden: {},
    releases: [{ id: chapterId, number: "1", volume: "", title: "Start", language: "en", pages: 20, groups: ["Manga Reborn"], publishedAt: "2020", readable: true }],
  })));
  renderWithApp(<MangaDexChapters title={title} />, saveExternalTitle(emptyUserData(), title, "now"));
  expect(await screen.findByRole("link", { name: /Start.*Read in MangaReader/ })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${chapterId}`));
  expect(screen.getByText(/1 readable English releases/)).toBeInTheDocument();
});

it("shows official catalogue links and explains withheld releases when nothing is readable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({
    status: "verified",
    mangaId,
    officialLinks: [{ label: "Official English release (viz.com)", url: "https://www.viz.com/shonenjump/chapters/one-punch-man" }],
    licensedInEnglish: true,
    hidden: { "licensed-in-english": 4, uncredited: 1 },
    releases: [],
  })));
  renderWithApp(<MangaDexChapters title={opm} />, saveExternalTitle(emptyUserData(), opm, "now"));
  expect(await screen.findByRole("link", { name: /Read One-Punch Man on VIZ/ })).toHaveAttribute("href", expect.stringContaining("viz.com"));
  expect(screen.getByText(/5 releases withheld/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Read in MangaReader/ })).not.toBeInTheDocument();
});

it("keeps external-only chapters out of the in-app reader", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({
    status: "verified",
    mangaId,
    officialLinks: [],
    licensedInEnglish: false,
    hidden: {},
    releases: [{ id: chapterId, number: "12", volume: "", title: "", language: "en", pages: 0, groups: ["Publisher"], publishedAt: "2020", readable: false, externalUrl: "https://publisher.example/ch12", restriction: "external" }],
  })));
  renderWithApp(<MangaDexChapters title={title} />, saveExternalTitle(emptyUserData(), title, "now"));
  const link = await screen.findByRole("link", { name: /12/ });
  expect(link).toHaveAttribute("href", "https://publisher.example/ch12");
  expect(link).not.toHaveAttribute("href", expect.stringContaining("/mangadex/read/"));
});

it("surfaces edition conflicts instead of guessing a chapter list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Multiple or conflicting editions claim this identifier. Edition verification needs review." }, 502)));
  // discoverReadingSources throws from provider when status is conflict; simulate HTTP error path used by getSourceJson.
  renderWithApp(<MangaDexChapters title={title} />, saveExternalTitle(emptyUserData(), title, "now"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Multiple or conflicting editions|Chapter service returned HTTP 502|conflicting editions/i);
});

it("offers Continue from series detail using saved MangaDex progress", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ status: "verified", mangaId, officialLinks: [], licensedInEnglish: false, hidden: {}, releases: [] })));
  const data = saveExternalTitle(emptyUserData(), title, "now");
  data.progress[title.id] = {
    lastChapterId: chapterId,
    updatedAt: "now",
    chapters: { [chapterId]: { page: 4, pageCount: 20, completed: false, atEnd: false, updatedAt: "now" } },
  };
  renderWithApp(<SeriesView series={seriesFromSaved(title)} savedTitle={title} />, data);
  expect(screen.getByRole("link", { name: /Continue · page 5/ })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${chapterId}`));
});

it("clears a stale chapter list before retrying a failed discovery", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ error: "busy" }, 429))
    .mockResolvedValueOnce(response({
      status: "verified",
      mangaId,
      officialLinks: [],
      licensedInEnglish: false,
      hidden: {},
      releases: [{ id: chapterId, number: "1", volume: "", title: "", language: "en", pages: 3, groups: ["Team"], publishedAt: "2020", readable: true }],
    }));
  vi.stubGlobal("fetch", fetcher);
  renderWithApp(<MangaDexChapters title={title} />, saveExternalTitle(emptyUserData(), title, "now"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/busy|429|try again/i);
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry chapters" }));
  await waitFor(() => expect(screen.getByRole("link", { name: /Chapter 1|1/ })).toBeInTheDocument());
});
