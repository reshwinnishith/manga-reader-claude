import { expect, it } from "vitest";
import { publisherLink } from "./official-links";
import { officialDestinations } from "./reading-sources";
import { normalizeMedia } from "./anilist";

it("accepts structured publisher links and preserves their stated language", () => {
  expect(publisherLink("https://mangaplus.shueisha.co.jp/titles/100020", "English")).toMatchObject({
    label: "MANGA Plus",
    language: "en",
  });
  expect(publisherLink("https://ebookjapan.yahoo.co.jp/books/942715/", "ja")).toMatchObject({
    label: "ebookjapan",
    language: "ja",
  });
  expect(publisherLink("https://www.viz.com/shonenjump/chapters/one-punch-man", undefined)?.language).toBe("und");
});

it.each([
  "javascript:alert(1)",
  "http://www.viz.com/read",
  "https://www.viz.com.evil.example/read",
  "https://user:secret@www.viz.com/read",
  "https://unverified-reader.example/chapter/1",
])("rejects unverified or unsafe destinations: %s", (url) => {
  expect(publisherLink(url, "en")).toBeNull();
});

it("does not lose the curated Murata fallback when metadata supplies the same URL", () => {
  const title = normalizeMedia(
    {
      id: 74347,
      title: { english: "One-Punch Man" },
      externalLinks: [{ site: "VIZ", url: "https://www.viz.com/shonenjump/chapters/one-punch-man", language: "English" }],
    },
    "now",
  )!;
  expect(officialDestinations(title)).toHaveLength(1);
  expect(officialDestinations(title)[0]?.label).toBe("Read One-Punch Man on VIZ / Shonen Jump");
});

it("keeps publisher reading external and links Skill Thief by its exact catalogue identifier", () => {
  const links = officialDestinations({ source: "mangaupdates", externalId: 60435684423 });
  expect(links.map((l) => l.language)).toEqual(["ko", "ja"]);
  expect(links.every((l) => l.capability === "external")).toBe(true);
  expect(officialDestinations({ source: "mangaupdates", externalId: 60435684424 })).toEqual([]);
});
