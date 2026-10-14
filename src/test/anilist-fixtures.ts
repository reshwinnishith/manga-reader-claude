/**
 * TEST FIXTURES, not live data. Shaped after AniList's documented GraphQL
 * response for the `Page.media` query in `services/anilist.ts`. They exercise
 * our parsing and UI; they do not prove the live API still returns this shape
 * (the build sandbox could not reach graphql.anilist.co).
 */
export const FIXTURE_MEDIA = {
  id: 101,
  title: { romaji: "Tsuki no Yakkyoku", english: "Moonlit Pharmacy (Fixture)" },
  description:
    "A pharmacist serves sleepless ghosts.<br><br>Based on <i>a fictional</i> story &amp; more.<br>~!Secret twist: it was the fox!~",
  coverImage: { large: "https://example.test/covers/101.jpg" },
  format: "MANGA",
  status: "RELEASING",
  chapters: 42,
  genres: ["Slice of Life", "Mystery", "Fantasy", "Comedy", "Drama", "Romance", "Extra"],
  startDate: { year: 2022 },
  countryOfOrigin: "JP",
  siteUrl: "https://anilist.co/manga/101",
  staff: {
    edges: [
      { role: "Story & Art", node: { name: { full: "Yuna Ashida" } } },
      { role: "Assistant", node: { name: { full: "Yuna Ashida" } } },
    ],
  },
};

export const FIXTURE_MANHWA = {
  id: 202,
  title: { romaji: "Tap-eui Sigye", english: null },
  description: null,
  coverImage: { large: null },
  status: "FINISHED",
  chapters: null,
  genres: ["Thriller"],
  startDate: { year: null },
  countryOfOrigin: "KR",
  siteUrl: null,
  staff: { edges: [] },
};

export const pageResponse = (media: unknown[], hasNextPage = false) => ({
  data: { Page: { pageInfo: { hasNextPage, currentPage: 1 }, media } },
});

export const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
