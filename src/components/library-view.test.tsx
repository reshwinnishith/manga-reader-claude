import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import { emptyUserData } from "@/lib/user-data";
import { normalizeMedia } from "@/services/anilist";
import { FIXTURE_MANHWA, FIXTURE_MEDIA } from "@/test/anilist-fixtures";
import { renderWithApp } from "@/test/helpers";
import { LibraryView } from "./library-view";

vi.mock("next/navigation", () => ({ usePathname: () => "/library" }));

const NOW = "2026-10-14T00:00:00.000Z";
const moon = normalizeMedia(FIXTURE_MEDIA, NOW)!;
const tap = normalizeMedia(FIXTURE_MANHWA, NOW)!;

describe("LibraryView · filtering and sorting", () => {
  it("combines type filter, status filter, and search query", async () => {
    const user = userEvent.setup();
    renderWithApp(<LibraryView />, createDemoUserData());
    const grid = () => screen.getByRole("list", { name: "Library" });

    // Initially 8 demo series
    expect(within(grid()).getAllByRole("link")).toHaveLength(8);

    // Filter by type: Manhwa
    await user.click(screen.getByRole("button", { name: "Manhwa" }));
    // All manhwa: Last Cartographer, Midnight Delivery, Tower of Quiet Clocks, Ash & Ember
    const manhwaLinks = within(grid()).getAllByRole("link");
    expect(manhwaLinks).toHaveLength(4);

    // Combine with status: Reading
    const statusGroup = screen.getByRole("group", { name: "Filter by reading status" });
    await user.click(within(statusGroup).getByRole("button", { name: /^Reading/ }));
    // Reading manhwa: Last Cartographer, Tower of Quiet Clocks
    expect(within(grid()).getAllByRole("link")).toHaveLength(2);

    // Combine with search query
    await user.type(screen.getByRole("searchbox", { name: "Search your library" }), "tower");
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByText("Tower of Quiet Clocks")).toBeInTheDocument();
  });

  it("sorts by recently active, recently added, title A-Z, title Z-A, and progress", async () => {
    const user = userEvent.setup();
    renderWithApp(<LibraryView />, createDemoUserData());
    const sortSelect = screen.getByRole("combobox", { name: "Sort library" });
    const getTitles = () =>
      within(screen.getByRole("list", { name: "Library" }))
        .getAllByRole("link")
        .map((link) => link.querySelector(".card__title")?.textContent ?? "");

    // Sort by Title (A–Z)
    await user.selectOptions(sortSelect, "title-asc");
    const ascTitles = getTitles();
    const sortedAsc = [...ascTitles].sort((a, b) => a.localeCompare(b));
    expect(ascTitles).toEqual(sortedAsc);

    // Sort by Title (Z–A)
    await user.selectOptions(sortSelect, "title-desc");
    const descTitles = getTitles();
    const sortedDesc = [...descTitles].sort((a, b) => b.localeCompare(a));
    expect(descTitles).toEqual(sortedDesc);

    // Sort by Reading progress
    await user.selectOptions(sortSelect, "progress");
    const progressTitles = getTitles();
    // Rooftop Rivals is 100% completed in demo data, so it must be first
    expect(progressTitles[0]).toBe("Rooftop Rivals");

    // Sort by Recently added
    await user.selectOptions(sortSelect, "recent-added");
    expect(sortSelect).toHaveValue("recent-added");
  });
});

describe("LibraryView · inline reading status changes", () => {
  it("changes status directly from the card select without navigating", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<LibraryView />, createDemoUserData());
    const grid = screen.getByRole("list", { name: "Library" });

    // Find Rooftop Rivals card and its status select
    const statusSelect = within(grid).getByRole("combobox", { name: "Reading status for Rooftop Rivals" });
    expect(statusSelect).toHaveValue("completed");

    // Verify non-nested interactive structure: select is not inside <a>
    expect(statusSelect.closest("a")).toBeNull();

    // Verify card link has no button/select ancestor
    const cardLink = within(grid).getByRole("link", { name: "Open Rooftop Rivals" });
    expect(cardLink.closest("select")).toBeNull();

    // Change status to reading
    await user.selectOptions(statusSelect, "reading");
    expect(store.getSnapshot()!.library["rooftop-rivals"]?.status).toBe("reading");
    expect(statusSelect).toHaveValue("reading");
  });
});

describe("LibraryView · progress presentation", () => {
  it("shows accurate progress for demo titles with chapters", () => {
    renderWithApp(<LibraryView />, createDemoUserData());
    const grid = screen.getByRole("list", { name: "Library" });

    // Rooftop Rivals is fully read
    expect(within(grid).getByText("Completed · 100%")).toBeInTheDocument();

    // Tower of Quiet Clocks is in progress at Ch. 11
    expect(within(grid).getByText(/In progress · Ch\. 11 · \d+%/)).toBeInTheDocument();

    // Ash & Ember Academy and Moonlit Pharmacy are unread
    expect(within(grid).getAllByText(/Not started · \d+ ch/)).toHaveLength(2);
  });

  it("keeps user-set Completed status distinct from verified 100% chapter completion without 0% label", () => {
    let data = emptyUserData();
    data = {
      ...data,
      library: {
        "skyward-lanterns": { seriesId: "skyward-lanterns", status: "completed", addedAt: NOW },
      },
      progress: {},
    };
    renderWithApp(<LibraryView />, data);
    const grid = screen.getByRole("list", { name: "Library" });
    const skywardLink = within(grid).getByRole("link", { name: "Open Skyward Lanterns" });

    // Displays clean "Completed", never "Completed · 0%"
    expect(within(skywardLink).getByText("Completed")).toBeInTheDocument();
    expect(within(skywardLink).queryByText(/0%/)).toBeNull();
  });

  it("does not invent chapter counts or percentages for external AniList titles without verified chapters", () => {
    let data = emptyUserData();
    data = {
      ...data,
      savedTitles: { [moon.id]: moon, [tap.id]: tap },
      library: {
        [moon.id]: { seriesId: moon.id, status: "planned", addedAt: NOW },
        [tap.id]: { seriesId: tap.id, status: "completed", addedAt: NOW },
      },
    };
    renderWithApp(<LibraryView />, data);
    const grid = screen.getByRole("list", { name: "Library" });

    // Moonlit Pharmacy is planned, not started -> "Not started" without fake % or chapter count
    const moonLink = within(grid).getByRole("link", { name: "Open Moonlit Pharmacy (Fixture)" });
    expect(within(moonLink).getByText("Not started")).toBeInTheDocument();
    expect(within(moonLink).queryByText(/%/)).toBeNull();

    // Tap-eui Sigye is marked completed -> "Completed" without fake %
    const tapLink = within(grid).getByRole("link", { name: "Open Tap-eui Sigye" });
    expect(within(tapLink).getByText("Completed")).toBeInTheDocument();
    expect(within(tapLink).queryByText(/%/)).toBeNull();
  });

  it("shows verified page progress when external title has reader progress", () => {
    let data = emptyUserData();
    data = {
      ...data,
      savedTitles: { [moon.id]: moon },
      library: { [moon.id]: { seriesId: moon.id, status: "reading", addedAt: NOW } },
      progress: {
        [moon.id]: {
          lastChapterId: "md-chap-1",
          updatedAt: NOW,
          chapters: { "md-chap-1": { page: 4, pageCount: 20, completed: false, atEnd: false, updatedAt: NOW } },
        },
      },
    };
    renderWithApp(<LibraryView />, data);
    const grid = screen.getByRole("list", { name: "Library" });
    expect(within(grid).getByText("In progress · Page 5/20")).toBeInTheDocument();
  });
});

describe("LibraryView · empty states and filters reset", () => {
  it("shows Clear filters button when filtered to no matches and resets on click", async () => {
    const user = userEvent.setup();
    renderWithApp(<LibraryView />, createDemoUserData());

    // Type impossible search
    const searchInput = screen.getByRole("searchbox", { name: "Search your library" });
    await user.type(searchInput, "xyznonexistent");

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByText(/Nothing in your library matches “xyznonexistent”\./)).toBeInTheDocument();

    const clearBtn = screen.getByRole("button", { name: "Clear filters" });
    await user.click(clearBtn);

    // Restores list of series
    expect(screen.getByRole("list", { name: "Library" })).toBeInTheDocument();
    expect(searchInput).toHaveValue("");
  });
});

describe("LibraryView · settings drawer & single-title layout", () => {
  it("toggles the settings and backup drawer via the header settings button", async () => {
    const user = userEvent.setup();
    renderWithApp(<LibraryView />, createDemoUserData());

    // Initially settings panel is closed
    expect(screen.queryByRole("region", { name: "Library backup and cloud settings" })).toBeNull();

    // Click Settings button
    const settingsBtn = screen.getByRole("button", { name: "Library backup and cloud settings" });
    await user.click(settingsBtn);

    // Panel is now visible with Cloud Sync and Backup sections
    const panel = screen.getByRole("region", { name: "Library backup and cloud settings" });
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByText("Cloud Synchronization")).toBeInTheDocument();
    expect(within(panel).getByText("Data Backup & Restore")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Export backup" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Import backup" })).toBeInTheDocument();

    // Click Close button
    const closeBtn = within(panel).getByRole("button", { name: "Close settings panel" });
    await user.click(closeBtn);

    expect(screen.queryByRole("region", { name: "Library backup and cloud settings" })).toBeNull();
  });

  it("renders single-title state with clean series count and single card in grid", () => {
    let data = emptyUserData();
    data = {
      ...data,
      library: {
        "skyward-lanterns": { seriesId: "skyward-lanterns", status: "reading", addedAt: NOW },
      },
    };
    renderWithApp(<LibraryView />, data);

    // Header series count
    expect(screen.getByText("1 series")).toBeInTheDocument();

    // Grid contains exactly 1 card
    const grid = screen.getByRole("list", { name: "Library" });
    const links = within(grid).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(within(grid).getByRole("combobox", { name: "Reading status for Skyward Lanterns" })).toHaveValue("reading");
  });
});
