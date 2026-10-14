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
const mangaId = "12345678-1234-4123-8123-123456789000";
const title = normalizeMedia({ id: 74347, title: { english: "One-Punch Man" }, status: "FINISHED" }, "now")!;
const initial = () => saveExternalTitle(emptyUserData(), title, "now");
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/chapter/") ? response({ pageCount: 3, seriesId: title.id, number: "1", group: "Test team", mangaId }) : response({ data: [id, second].map((id, i) => ({ id, attributes: { chapter: String(i + 1), pages: 3, translatedLanguage: "en" } })), total: 2 })));
});
afterEach(() => vi.unstubAllGlobals());

it("saves only loaded pages, retries failures, and completes only on explicit finish", async () => {
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
  await user.click(screen.getByRole("button", { name: "Finish chapter" }));
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

it("resolves next chapters from the complete feed rather than URL navigation hints", async () => {
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} next={{ id: mangaId, number: "999" }} />, initial());
  expect(await screen.findByRole("link", { name: "Chapter 2 →" })).toHaveAttribute("href", expect.stringContaining(`/mangadex/read/${second}`));
  expect(screen.queryByRole("link", { name: /999/ })).not.toBeInTheDocument();
});

it("rejects a chapter belonging to a different edition without recording progress", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ pageCount: 3, seriesId: "al-85364", number: "1", group: "ONE", mangaId })));
  const { store } = renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("alert")).toHaveTextContent("does not belong");
  expect(store.getSnapshot()?.progress).toEqual({});
});

it("shows removed chapter errors and supports a successful retry", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ error: "Chapter removed" }, 502)).mockResolvedValueOnce(response({ pageCount: 1, seriesId: title.id, number: "0", group: "Team", mangaId })).mockResolvedValue(response({ data: [], total: 0 }));
  vi.stubGlobal("fetch", fetcher);
  renderWithApp(<MangaDexReader id={id} group="" seriesId={title.id} />, initial());
  expect(await screen.findByRole("alert")).toHaveTextContent("Chapter removed");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry chapter" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Page 1" })).toBeInTheDocument());
});
