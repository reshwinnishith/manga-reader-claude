import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createDemoUserData } from "@/data/demo-user-data";
import { emptyUserData, setReaderMode } from "@/lib/user-data";
import { getSeries, renderWithApp } from "@/test/helpers";
import { ReaderView } from "./reader-view";

// jsdom has no layout engine
Element.prototype.scrollIntoView = () => {};

const manga = getSeries("neon-ronin"); // paged right-to-left by default
const manhwa = getSeries("last-cartographer"); // vertical by default

const savedPage = (store: ReturnType<typeof renderWithApp>["store"], s: typeof manga, chapter: number) =>
  store.getSnapshot()?.progress[s.id]?.chapters[`${s.id}-c${chapter}`]?.page;

describe("Reader · paged right-to-left (manga)", () => {
  const c1 = manga.chapters[0]!;

  it("opens on page 1, advances with the left tap zone and goes back with the right", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());

    expect(screen.getByRole("img", { name: new RegExp(`page 1 of ${c1.pageCount}`, "i") })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("img", { name: new RegExp(`page 3 of ${c1.pageCount}`, "i") })).toBeInTheDocument();
    expect(savedPage(store, manga, 1)).toBe(2);

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(savedPage(store, manga, 1)).toBe(1);
  });

  it("supports keyboard navigation in reading direction (left arrow = next)", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowRight}");
    expect(savedPage(store, manga, 1)).toBe(1);
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

  it("completes the chapter on the last page and offers the next chapter", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<ReaderView series={manga} chapterId={c1.id} />, emptyUserData());
    for (let i = 0; i < c1.pageCount; i++) await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(store.getSnapshot()?.progress[manga.id]?.chapters[c1.id]).toMatchObject({ completed: true, page: c1.pageCount - 1 });
    expect(screen.getByText("Ch. 1 complete")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to next chapter" })).toHaveAttribute(
      "href",
      `/read/${manga.id}/${manga.chapters[1]!.id}`,
    );
  });

  it("says you're caught up on the final chapter", async () => {
    const user = userEvent.setup();
    const last = manga.chapters.at(-1)!;
    renderWithApp(<ReaderView series={manga} chapterId={last.id} />, emptyUserData());
    for (let i = 0; i < last.pageCount; i++) await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue to next chapter" })).not.toBeInTheDocument();
  });

  it("restores the saved page when reopening a chapter", () => {
    renderWithApp(<ReaderView series={getSeries("skyward-lanterns")} chapterId="skyward-lanterns-c9" />, createDemoUserData());
    expect(screen.getByRole("img", { name: /page 7 of/i })).toBeInTheDocument();
  });

  it("links to previous/next chapters from the controls", () => {
    renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[1]!.id} />, emptyUserData());
    expect(screen.getByRole("link", { name: /Previous chapter, Ch\. 1/ })).toHaveAttribute("href", `/read/${manga.id}/${manga.chapters[0]!.id}`);
    expect(screen.getByRole("link", { name: /Next chapter, Ch\. 3/ })).toHaveAttribute("href", `/read/${manga.id}/${manga.chapters[2]!.id}`);
  });
});

describe("Reader · vertical scroll (manhwa)", () => {
  const c1 = manhwa.chapters[0]!;

  it("defaults to vertical for manhwa and renders every page in one scroll", () => {
    const { container } = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
    expect(container.querySelector(".reader")).toHaveAttribute("data-mode", "vertical");
    expect(container.querySelectorAll(".vpage")).toHaveLength(c1.pageCount);
    expect(screen.getByRole("link", { name: "Continue to next chapter" })).toBeInTheDocument();
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

  it("remembers the reading mode per series", async () => {
    const user = userEvent.setup();
    const { store, container } = renderWithApp(<ReaderView series={manhwa} chapterId={c1.id} />, emptyUserData());
    await user.click(screen.getByRole("button", { name: /Switch to paged/ }));
    expect(store.getSnapshot()?.readerModes[manhwa.id]).toBe("paged-rtl");
    expect(container.querySelector(".reader")).toHaveAttribute("data-mode", "paged-rtl");
    expect(store.getSnapshot()?.readerModes[manga.id]).toBeUndefined();
  });

  it("uses a stored per-series mode on open", () => {
    const stored = setReaderMode(emptyUserData(), manga.id, "vertical");
    const { container } = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, stored);
    expect(container.querySelector(".reader")).toHaveAttribute("data-mode", "vertical");
  });

  it("keeps the current page when switching modes", async () => {
    const user = userEvent.setup();
    const { store } = renderWithApp(<ReaderView series={manga} chapterId={manga.chapters[0]!.id} />, emptyUserData());
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await act(async () => {
      store.setReaderMode(manga.id, "vertical");
    });
    expect(savedPage(store, manga, 1)).toBe(2);
  });
});

describe("Reader · errors", () => {
  it("shows a recoverable message for an unknown chapter", () => {
    renderWithApp(<ReaderView series={manga} chapterId="nope" />, emptyUserData());
    expect(screen.getByRole("alert")).toHaveTextContent("could not be found");
    expect(screen.getByRole("link", { name: "Back to series" })).toHaveAttribute("href", `/series/${manga.id}`);
  });
});
