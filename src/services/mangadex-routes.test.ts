import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/mangadex/discover/route";
import { chapterIdentity } from "./mangadex-chapter";
const id = "1369226a-5c75-4bbf-b385-d884228a9cfe";
const mangaId = "d8a959f7-648e-4c8d-8f23-f1f3f8e129f3";
const json = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => vi.unstubAllGlobals());
it("includes suggestive non-adult editions in discovery, which is required for Murata's OPM", async () => {
  const fetcher = vi.fn(async (url: URL) => { expect(url.hostname).toBe("api.mangadex.org"); return json({ data: [] }); }); vi.stubGlobal("fetch", fetcher);
  expect((await GET(new NextRequest("http://localhost/api/mangadex/discover?title=One-Punch+Man"))).status).toBe(200);
  const url = fetcher.mock.calls[0]?.[0] as unknown as URL;
  expect(url.searchParams.getAll("contentRating[]")).toEqual(["safe", "suggestive"]);
  expect(url.searchParams.getAll("includes[]")).toContain("artist");
});
it("rejects invalid offsets without an upstream request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect((await GET(new NextRequest(`http://localhost/api/mangadex/discover?id=${mangaId}&offset=101`))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it("gets chapter identity and credits from the source, including a chapter zero", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ data: { id, attributes: { chapter: "0" }, relationships: [{ type: "manga", id: mangaId }, { type: "scanlation_group", attributes: { name: "Real team" } }] } })).mockResolvedValueOnce(json({ data: { id: mangaId, attributes: { title: { en: "One-Punch Man" }, links: { al: "74347" } } } })));
  expect(await chapterIdentity(id)).toMatchObject({ seriesId: "al-74347", number: "0", group: "Real team", mangaId });
});
it("rejects external-only chapters before attempting a page manifest", async () => {
  const fetcher = vi.fn(async () => json({ data: { id, attributes: { externalUrl: "https://publisher.example/chapter" }, relationships: [{ type: "manga", id: mangaId }] } }));
  vi.stubGlobal("fetch", fetcher);
  // The reader verifies the parent manga before applying chapter restrictions.
  fetcher.mockResolvedValueOnce(json({ data: { id, attributes: { externalUrl: "https://publisher.example/chapter" }, relationships: [{ type: "manga", id: mangaId }] } }))
    .mockResolvedValueOnce(json({ data: { id: mangaId, attributes: { title: { en: "Example" }, links: { al: "74347" } } } }));
  await expect(chapterIdentity(id)).rejects.toThrow("only available at its source");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
