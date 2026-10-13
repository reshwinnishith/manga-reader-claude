import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import { emptyUserData } from "@/lib/user-data";
import { getSeries, renderWithApp } from "@/test/helpers";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { DiscoverView } from "./discover-view";
import { HomeView } from "./home-view";
import { LibraryView } from "./library-view";
import { SeriesView } from "./series-view";

describe("Home", () => {
  it("shows a Continue Reading hero linking straight into the reader at the resume chapter", () => {
    renderWithApp(<HomeView />, createDemoUserData());
    const hero = screen.getByRole("link", { name: /^Continue Tower of Quiet Clocks, Ch\. 11, page 5/ });
    expect(hero).toHaveAttribute("href", "/read/tower-of-quiet-clocks/tower-of-quiet-clocks-c11");
    expect(screen.getByRole("heading", { name: "New Chapters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recently Added" })).toBeInTheDocument();
  });

  it("shows friendly empty states for a new user", () => {
    renderWithApp(<HomeView />, emptyUserData());
    expect(screen.getByText("Nothing in progress")).toBeInTheDocument();
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Discover series" })).toHaveAttribute("href", "/discover");
  });
});

describe("Library", () => {
  it("filters by reading status and search, with a clear empty state", async () => {
    const user = userEvent.setup();
    renderWithApp(<LibraryView />, createDemoUserData());
    const grid = () => screen.getByRole("list", { name: "Library" });
    expect(within(grid()).getAllByRole("link")).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByText("Rooftop Rivals")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^All/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search your library" }), "zzzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("explains an empty library and points to Discover", () => {
    renderWithApp(<LibraryView />, emptyUserData());
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find something to read" })).toHaveAttribute("href", "/discover");
  });
});

describe("Discover", () => {
  it("searches the mock catalog and adds a series to the library", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<DiscoverView />, emptyUserData());
    await user.type(screen.getByRole("searchbox", { name: "Search the catalog" }), "neon");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Add Neon Ronin to library" }));
    expect(store.getSnapshot()?.library["neon-ronin"]?.status).toBe("planned");
    expect(screen.getByRole("button", { name: "Remove Neon Ronin from library" })).toHaveAttribute("aria-pressed", "true");

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "qqqq");
    expect(screen.getByText("No results")).toBeInTheDocument();
  });
});

describe("Series detail", () => {
  const series = getSeries("skyward-lanterns");

  it("offers Start reading at chapter 1 for an unread series", () => {
    renderWithApp(<SeriesView series={series} />, emptyUserData());
    expect(screen.getByRole("link", { name: /Start reading/ })).toHaveAttribute("href", `/read/${series.id}/${series.chapters[0]!.id}`);
    expect(screen.getAllByRole("link", { name: /Ch\. \d+,/ })).toHaveLength(series.chapters.length);
  });

  it("offers Continue with progress at the saved chapter and marks chapter states", () => {
    renderWithApp(<SeriesView series={series} />, createDemoUserData());
    const cta = screen.getByRole("link", { name: /Continue · Ch\. 9/ });
    expect(cta).toHaveAttribute("href", `/read/${series.id}/${series.id}-c9`);
    expect(screen.getByText(/Ch\. 9, page 7\//)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ch\. 1, .*, read$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ch\. 9, .*, in progress$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ch\. 12, .*, unread$/ })).toBeInTheDocument();
  });
});
