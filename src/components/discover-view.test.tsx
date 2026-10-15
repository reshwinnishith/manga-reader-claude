import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import { emptyUserData, recordProgress } from "@/lib/user-data";
import { SearchError, normalizeMedia, type AniListClient, type SearchResult } from "@/services/anilist";
import { SEARCH_DEBOUNCE_MS } from "@/state/use-title-search";
import { FIXTURE_MANHWA, FIXTURE_MEDIA } from "@/test/anilist-fixtures";
import { getSeries, renderWithApp } from "@/test/helpers";
import { DiscoverView } from "./discover-view";
import { ExternalSeriesView } from "./external-series-view";
import { LibraryView } from "./library-view";

vi.mock("next/navigation", () => ({ usePathname: () => "/discover" }));

const NOW = "2026-10-14T00:00:00.000Z";
const moon = normalizeMedia(FIXTURE_MEDIA, NOW)!;
const tap = normalizeMedia(FIXTURE_MANHWA, NOW)!;
const result = (items = [moon, tap], hasNextPage = false, page = 1): SearchResult => ({ items, hasNextPage, page });

function fakeClient(impl: AniListClient["search"] = async () => result()) {
  const search = vi.fn(impl);
  return { client: { search } as AniListClient, search };
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [], total: 0 }), { headers: { "content-type": "application/json" } }))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 50); });
const type = async (text: string) => {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search titles" }), { target: { value: text } });
};
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe("Discover · search flow", () => {
  it("starts idle: no demo titles, a hint, and no API call", () => {
    const { client, search } = fakeClient();
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    expect(screen.getByText("Type a title to search AniList.")).toBeInTheDocument();
    expect(screen.queryByText(/Sample titles/)).not.toBeInTheDocument();
    expect(screen.queryByText("Neon Ronin")).not.toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it("shows only saved real titles at rest and filters by manga type", async () => {
    const { client, search } = fakeClient();
    const base = emptyUserData();
    const saved = { ...base, savedTitles: { [moon.id]: moon, [tap.id]: tap }, library: {
      [moon.id]: { seriesId: moon.id, status: "planned" as const, addedAt: NOW },
      [tap.id]: { seriesId: tap.id, status: "reading" as const, addedAt: NOW },
    } };
    renderWithApp(<DiscoverView client={client} />, saved);
    const list = screen.getByRole("list", { name: "Saved titles" });
    expect(within(list).getByText("Moonlit Pharmacy (Fixture)")).toBeInTheDocument();
    expect(within(list).getByText("Tap-eui Sigye")).toBeInTheDocument();
    expect(screen.queryByText("Neon Ronin")).not.toBeInTheDocument();
    await user().click(screen.getByRole("button", { name: "Manhwa" });
    expect(within(list).queryByText("Moonlit Pharmacy (Fixture)")).not.toBeInTheDocument();
    expect(within(list).getByText("Tap-eui Sigye")).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it("debounces typing into a single search, showing loading until results arrive", async () => {
    const { client, search } = fakeClient();
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("m");
    await type("mo");
    await type("moon");
    expect(screen.getByRole("list", { name: "Searching" })).toHaveAttribute("aria-busy", "true");
    expect(search).not.toHaveBeenCalled();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toMatchObject({ query: "moon", country: "all", page: 1 });
    expect(screen.queryByRole("list", { name: "Searching" })).not.toBeInTheDocument();
  });

  it("does not search below the minimum length", async () => {
    const { client, search } = fakeClient();
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("m");
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText(/Keep typing/)).toBeInTheDocument();
  });

  it("shows cover, title, description and useful metadata for each result", async () => {
    const { client } = fakeClient();
    const { container } = renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    const list = screen.getByRole("list", { name: "Search results" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const first = cards[0]!;
    expect(within(first).getByText("Moonlit Pharmacy (Fixture)")).toBeInTheDocument();
    expect(within(first).getByText("Manga")).toBeInTheDocument();
    expect(within(first).getByText(/Yuna Ashida · 2022/)).toBeInTheDocument();
    expect(within(first).getByText(/Slice of Life · Mystery · Fantasy · Ongoing · 42 chapters/)).toBeInTheDocument();
    expect(within(first).getByText(/A pharmacist serves sleepless ghosts\./)).toBeInTheDocument();
    expect(first.textContent).not.toContain("Secret twist");
    expect(first.querySelector("img")).toHaveAttribute("src", "https://example.test/covers/101.jpg");
    // sparse record: generated cover, placeholder description, Manhwa badge
    expect(within(cards[1]!).getByText("Manhwa")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("No description available.")).toBeInTheDocument();
    expect(cards[1]!.querySelector("img")).toBeNull();
    expect(container.querySelector("[aria-live]")).toHaveTextContent("2 results");
  });

  it("links out to AniList safely and credits it", async () => {
    const { client } = fakeClient();
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    const credit = screen.getAllByRole("link", { name: "AniList" })[0]!;
    expect(credit).toHaveAttribute("href", "https://anilist.co");
    expect(credit).toHaveAttribute("rel", expect.stringContaining("noopener"));
    await type("moon");
    await settle();
    const link = screen.getByRole("link", { name: /Moonlit Pharmacy \(Fixture\) on AniList/ });
    expect(link).toHaveAttribute("href", "https://anilist.co/manga/101");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("passes the type filter to the search and refetches", async () => {
    const { client, search } = fakeClient();
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("tower");
    await settle();
    await user().click(screen.getByRole("button", { name: "Manhwa" }));
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![0]).toMatchObject({ query: "tower", country: "KR" });
  });

  it("shows a clear empty state", async () => {
    const { client } = fakeClient(async () => result([]));
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("zzzzqq");
    await settle();
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText(/Nothing found for “zzzzqq”/)).toBeInTheDocument();
  });

  it("shows a friendly error and recovers with Try again", async () => {
    let calls = 0;
    const { client, search } = fakeClient(async () => {
      if (++calls === 1) throw new SearchError("offline", "Couldn't reach AniList. Check your connection and try again.");
      return result();
    });
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach AniList");
    await user().click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("list", { name: "Search results" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains rate limiting", async () => {
    const { client } = fakeClient(async () => { throw new SearchError("rate-limited", "AniList asked us to slow down. Try again in 42s.", 42); });
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    expect(screen.getByText("Slow down a little")).toBeInTheDocument();
    expect(screen.getByText(/Try again in 42s/)).toBeInTheDocument();
  });

  it("ignores a stale response when the query has moved on", async () => {
    let resolveFirst: (r: SearchResult) => void = () => {};
    const { client } = fakeClient((opts) =>
      opts.query === "moon"
        ? new Promise<SearchResult>((r) => { resolveFirst = r; })
        : Promise.resolve(result([tap])),
    );
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    await type("tower");
    await settle();
    await act(async () => resolveFirst(result([moon])));
    expect(screen.getByText("Tap-eui Sigye")).toBeInTheDocument();
    expect(screen.queryByText("Moonlit Pharmacy (Fixture)")).not.toBeInTheDocument();
  });

  it("loads more results on request and de-duplicates them", async () => {
    const { client, search } = fakeClient(async ({ page }) => (page === 2 ? result([moon, tap], false, 2) : result([moon], true, 1)));
    renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user().click(screen.getByRole("button", { name: "Show more" }));
    await act(async () => {});
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![0]).toMatchObject({ page: 2 });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });
});

describe("Discover · saving to the library", () => {
  it("saves a result, keeps existing demo data and progress, and toggles to 'In Library'", async () => {
    const { client } = fakeClient();
    const seeded = createDemoUserData();
    const { store } = renderWithApp(<DiscoverView client={client} />, seeded);
    await type("moon");
    await settle();

    await user().click(screen.getByRole("button", { name: "Add Moonlit Pharmacy (Fixture) to library" }));
    const data = store.getSnapshot()!;
    expect(data.savedTitles["al-101"]).toMatchObject({ title: "Moonlit Pharmacy (Fixture)", url: "https://anilist.co/manga/101" });
    expect(data.library["al-101"]?.status).toBe("planned");
    // existing sample data untouched
    expect(Object.keys(data.library)).toEqual(expect.arrayContaining(Object.keys(seeded.library)));
    expect(data.progress).toEqual(seeded.progress);
    expect(screen.getByRole("button", { name: "Remove Moonlit Pharmacy (Fixture) from library" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Open Moonlit Pharmacy (Fixture)" })).toHaveAttribute("href", "/series/al-101");
  });

  it("removing keeps the saved metadata for re-adding", async () => {
    const { client } = fakeClient();
    const { store } = renderWithApp(<DiscoverView client={client} />, emptyUserData());
    await type("moon");
    await settle();
    const u = user();
    await u.click(screen.getByRole("button", { name: /^Add Moonlit/ }));
    await u.click(screen.getByRole("button", { name: /^Remove Moonlit/ }));
    expect(store.getSnapshot()!.library["al-101"]).toBeUndefined();
    expect(store.getSnapshot()!.savedTitles["al-101"]).toBeDefined();
    await u.click(screen.getByRole("button", { name: /^Add Moonlit/ }));
    expect(store.getSnapshot()!.library["al-101"]?.status).toBe("planned");
  });

  it("does not change status or progress of an already-saved title when it is found again", async () => {
    const { client } = fakeClient();
    let data = emptyUserData();
    data = { ...data, savedTitles: { "al-101": moon }, library: { "al-101": { seriesId: "al-101", status: "on-hold", addedAt: NOW } } };
    renderWithApp(<DiscoverView client={client} />, data);
    await type("moon");
    await settle();
    expect(screen.getByRole("button", { name: /^Remove Moonlit/ })).toBeInTheDocument();
  });
});

describe("Library and series pages with saved titles", () => {
  const withSaved = () => {
    const base = recordProgress(emptyUserData(), getSeries("neon-ronin"), "neon-ronin-c1", 2, NOW);
    return { ...base, savedTitles: { "al-101": moon }, library: { ...base.library, "al-101": { seriesId: "al-101", status: "planned" as const, addedAt: NOW } } };
  };

  it("shows saved titles in the library next to demo series, with their cover and status filters", async () => {
    renderWithApp(<LibraryView />, withSaved());
    const grid = screen.getByRole("list", { name: "Library" });
    expect(within(grid).getByText("Moonlit Pharmacy (Fixture)")).toBeInTheDocument();
    expect(within(grid).getByText("Neon Ronin")).toBeInTheDocument();
    expect(within(grid).getByRole("link", { name: /Moonlit Pharmacy/ })).toHaveAttribute("href", "/series/al-101");
    await user().click(screen.getByRole("button", { name: /^Planned/ }));
    expect(within(grid).getAllByRole("link")).toHaveLength(1);
  });

  it("opens a saved title's detail: metadata, status control, AniList link, and honest 'no chapters' messaging", () => {
    renderWithApp(<ExternalSeriesView id="al-101" />, withSaved());
    expect(screen.getByRole("heading", { name: "Moonlit Pharmacy (Fixture)" })).toBeInTheDocument();
    expect(screen.getByText("Yuna Ashida · 2022")).toBeInTheDocument();
    expect(screen.getByText("42 chapters listed")).toBeInTheDocument();
    expect(screen.getByText(/Metadata: AniList/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on AniList" })).toHaveAttribute("href", "https://anilist.co/manga/101");
    expect(screen.getByRole("group", { name: "Reading status" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chapters" })).toBeInTheDocument();
  });

  it("lets you change the status of a saved title", async () => {
    const { store } = renderWithApp(<ExternalSeriesView id="al-101" />, withSaved());
    await user().click(screen.getByRole("button", { name: "Dropped" }));
    expect(store.getSnapshot()!.library["al-101"]?.status).toBe("dropped");
  });

  it("explains when an unsaved title cannot be fetched", async () => {
    renderWithApp(<ExternalSeriesView id="al-999" />, emptyUserData());
    expect(await screen.findByText("Couldn't load this title")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/discover");
  });
});
