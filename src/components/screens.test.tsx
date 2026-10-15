import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import { emptyUserData, recordProgress } from "@/lib/user-data";
import { getSeries, renderWithApp } from "@/test/helpers";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

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
    expect(within(grid()).getAllByRole("link")).toHaveLength(8);

    await user.click(screen.getByRole("button", { name: /^Completed/ }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByText("Rooftop Rivals")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^On Hold/ }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByText("Midnight Delivery Service")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Dropped/ }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByText("Neon Ronin")).toBeInTheDocument();

    const statusGroup = screen.getByRole("group", { name: "Filter by reading status" });
    await user.click(within(statusGroup).getByRole("button", { name: /^All/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search your library" }), "zzzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("lists every status filter with a count, and shows a clear empty state for an empty one", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<LibraryView />, createDemoUserData());
    const group = screen.getByRole("group", { name: "Filter by reading status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "All8", "Reading3", "Planned2", "On Hold1", "Dropped1", "Completed1",
    ]);
    await act(async () => store.setReadingStatus("neon-ronin", "completed"));
    await act(async () => store.setReadingStatus("midnight-delivery", "completed"));
    await user.click(within(group).getByRole("button", { name: /^Dropped/ }));
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByText("No series marked Dropped.")).toBeInTheDocument();
  });

  it("explains an empty library and points to Discover", () => {
    renderWithApp(<LibraryView />, emptyUserData());
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find something to read" })).toHaveAttribute("href", "/discover");
  });
});

describe("Home · inactive statuses", () => {
  it("keeps on-hold and dropped series out of Continue Reading and New Chapters", () => {
    renderWithApp(<HomeView />, createDemoUserData());
    expect(screen.queryByText("Midnight Delivery Service")).not.toBeInTheDocument();
    expect(screen.queryByText("Neon Ronin")).not.toBeInTheDocument();
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

  it("lets you set every reading status, including On Hold and Dropped", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<SeriesView series={series} />, createDemoUserData());
    const group = screen.getByRole("group", { name: "Reading status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Reading", "Planned", "On Hold", "Dropped", "Completed",
    ]);
    await user.click(within(group).getByRole("button", { name: "On Hold" }));
    expect(store.getSnapshot()?.library[series.id]?.status).toBe("on-hold");
    expect(within(group).getByRole("button", { name: "On Hold" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "Dropped" }));
    expect(store.getSnapshot()?.library[series.id]?.status).toBe("dropped");
  });

  it("shows a 'caught up' call to action once the latest chapter of an ongoing series is finished", () => {
    const last = series.chapters.at(-1)!;
    const data = recordProgress(emptyUserData(), series, last.id, last.pageCount - 1, "2026-10-12T00:00:00Z", true);
    renderWithApp(<SeriesView series={series} />, data);
    expect(screen.getByRole("link", { name: /Caught up · Read again/ })).toHaveAttribute("href", `/read/${series.id}/${last.id}`);
  });

  it("shows 'Continue' (not caught up) when only the final page of the latest chapter was visited", () => {
    const last = series.chapters.at(-1)!;
    const data = recordProgress(emptyUserData(), series, last.id, last.pageCount - 1, "2026-10-12T00:00:00Z", false);
    renderWithApp(<SeriesView series={series} />, data);
    expect(screen.getByRole("link", { name: new RegExp(`Continue · Ch\\. ${last.number}`) })).toBeInTheDocument();
  });
});
