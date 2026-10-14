import { describe, expect, it } from "vitest";
import { classifyRelease, verifyIdentity, type ReleaseRecord } from "./source-policy";
import { resolveEdition } from "./mangadex-server";

const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const manga = (id: string, al: string) => ({
  id,
  attributes: { title: { en: "Example" }, links: { al }, originalLanguage: "ja", contentRating: "safe" },
  relationships: [],
});
const release: ReleaseRecord = {
  id: uuidA, number: "1", volume: "1", title: "", language: "en", pages: 12,
  isUnavailable: false, publishedAt: "", groups: [{ name: "Translator", official: false }],
};
const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" },
});

describe("provider identity and access policy", () => {
  it("never allows a matching MAL ID to override a conflicting AniList ID", () => {
    expect(verifyIdentity({ al: "999", mal: "222" }, 111, 222)).toEqual({ verified: false, conflict: true });
  });

  it("accepts matching MAL only when no AniList link exists", () => {
    expect(verifyIdentity({ mal: "222" }, 111, 222)).toEqual({ verified: true, by: "myanimelist" });
  });

  it("withholds non-official English uploads under the conservative licensed-title policy", () => {
    expect(classifyRelease(release, { licensedInEnglish: true }).restriction).toBe("licensed-in-english");
    expect(classifyRelease(release, { licensedInEnglish: false }).readable).toBe(true);
    expect(classifyRelease({ ...release, groups: [{ name: "Publisher", official: true }] }, { licensedInEnglish: true }).readable).toBe(true);
  });

  it("rejects unavailable and uncredited chapter records", () => {
    expect(classifyRelease({ ...release, pages: 0 }, { licensedInEnglish: false }).readable).toBe(false);
    expect(classifyRelease({ ...release, groups: [] }, { licensedInEnglish: false }).restriction).toBe("uncredited");
  });
});

describe("edition resolution across aliases", () => {
  it("detects two verified editions appearing under different aliases", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/manga") {
        const title = url.searchParams.get("title");
        return response({ data: [manga(title === "Alias One" ? uuidA : uuidB, "712341")], total: 1 });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const result = await resolveEdition({
      anilistId: 712341, titles: ["Alias One", "Alias Two"],
    }, fetchMock);
    expect(result.status).toBe("conflict");
    expect(result.mangaId).toBeUndefined();
  });

  it("rejects an edition with a conflicting AniList link even if MAL matches", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/manga") {
        return response({ data: [{
          ...manga(uuidA, "12345"),
          attributes: { title: { en: "Wrong Edition" }, links: { al: "12345", mal: "45678" } },
        }], total: 1 });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const result = await resolveEdition({
      anilistId: 87654, malId: 45678, titles: ["Wrong Edition"],
    }, fetchMock);
    expect(result.status).toBe("conflict");
  });
});
