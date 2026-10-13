import type { Chapter, Series } from "@/domain/types";

/**
 * The mock "clock". Release dates below are absolute and relative to this
 * fixed moment so server and client always render identical output and tests
 * are deterministic. A real source adapter would use the real clock.
 */
export const MOCK_NOW = "2026-10-12T12:00:00Z";
/** Chapters released within this many days count as "new". */
export const NEW_CHAPTER_WINDOW_DAYS = 21;

const DAY = 24 * 60 * 60 * 1000;

function isoDaysBeforeNow(days: number): string {
  return new Date(Date.parse(MOCK_NOW) - days * DAY).toISOString().slice(0, 10);
}

interface ChapterSpec {
  id: string;
  count: number;
  /** Days before MOCK_NOW that the latest chapter was released. */
  latestDaysAgo: number;
  /** Days between chapters. */
  cadence: number;
  /** Base page count; varied slightly per chapter. */
  pages: number;
  titles: string[];
}

function buildChapters(spec: ChapterSpec): Chapter[] {
  return Array.from({ length: spec.count }, (_, i) => {
    const number = i + 1;
    const fromEnd = spec.count - number;
    return {
      id: `${spec.id}-c${number}`,
      number,
      title: spec.titles[i] ?? `Chapter ${number}`,
      pageCount: spec.pages + ((i * 3) % 5),
      releasedAt: isoDaysBeforeNow(spec.latestDaysAgo + fromEnd * spec.cadence),
    };
  });
}

const series = (
  base: Omit<Series, "chapters">,
  spec: Omit<ChapterSpec, "id">,
): Series => ({ ...base, chapters: buildChapters({ ...spec, id: base.id }) });

/**
 * Original fictional series. All artwork is generated locally as placeholder
 * SVG, so nothing here involves copyrighted material.
 */
export const MOCK_SERIES: Series[] = [
  series(
    {
      id: "skyward-lanterns",
      title: "Skyward Lanterns",
      type: "manga",
      author: "Haruka Minato",
      year: 2023,
      status: "ongoing",
      genres: ["Adventure", "Fantasy"],
      hue: 28,
      description:
        "Every year the island of Tsuru releases a thousand paper lanterns into the storm clouds. Mio, a lantern-maker's apprentice, discovers that one of them never falls — and follows it above the weather, into a sky full of forgotten cities.",
    },
    {
      count: 12,
      latestDaysAgo: 3,
      cadence: 7,
      pages: 14,
      titles: ["The Thousandth Light", "Storm Season", "Paper Wings", "Above the Rain", "The Drifting Market", "Sky Cartographers"],
    },
  ),
  series(
    {
      id: "last-cartographer",
      title: "The Last Cartographer",
      type: "manhwa",
      author: "Seo Ji-woo",
      year: 2024,
      status: "ongoing",
      genres: ["Fantasy", "Mystery"],
      hue: 205,
      description:
        "The world rearranges itself every night, and only one mapmaker can still draw it faithfully. When the capital vanishes overnight, Ren must cross a shifting continent to find out who is erasing the maps — and why they are afraid of him.",
    },
    {
      count: 10,
      latestDaysAgo: 2,
      cadence: 7,
      pages: 10,
      titles: ["Blank Parchment", "The Night Shift", "Ink and Salt", "Missing Capital", "North Is Moving"],
    },
  ),
  series(
    {
      id: "neon-ronin",
      title: "Neon Ronin",
      type: "manga",
      author: "Daichi Kuroda",
      year: 2021,
      status: "ongoing",
      genres: ["Sci-Fi", "Action"],
      hue: 310,
      description:
        "In a rain-soaked megacity, a masterless swordswoman takes contracts nobody else will touch. Her latest client wants a stolen memory back — a memory that happens to be hers.",
    },
    {
      count: 9,
      latestDaysAgo: 9,
      cadence: 14,
      pages: 16,
      titles: ["Contract Zero", "Afterglow", "Chrome Blossom", "The Quiet Blade"],
    },
  ),
  series(
    {
      id: "moonlit-pharmacy",
      title: "Moonlit Pharmacy",
      type: "manga",
      author: "Yuna Ashida",
      year: 2022,
      status: "ongoing",
      genres: ["Slice of Life", "Mystery"],
      hue: 168,
      description:
        "The pharmacy on Lantern Lane only opens after midnight, and its customers are never quite who they seem. Pharmacist Sora mixes remedies for sleepless ghosts, burned-out salarymen and one very polite fox.",
    },
    {
      count: 8,
      latestDaysAgo: 6,
      cadence: 10,
      pages: 12,
      titles: ["Insomnia Tonic", "The Polite Fox", "Cold Medicine for Spirits"],
    },
  ),
  series(
    {
      id: "tower-of-quiet-clocks",
      title: "Tower of Quiet Clocks",
      type: "manhwa",
      author: "Han Do-yoon",
      year: 2025,
      status: "ongoing",
      genres: ["Mystery", "Thriller"],
      hue: 48,
      description:
        "Floor by floor, a clock tower swallows anyone who climbs it. Climber Yeon has seven days and seven floors to reach the top and stop the final bell — before it rings for everyone she has ever known.",
    },
    {
      count: 14,
      latestDaysAgo: 1,
      cadence: 4,
      pages: 9,
      titles: ["Floor One", "The Second Hand", "Hourglass Room", "Overtime"],
    },
  ),
  series(
    {
      id: "rooftop-rivals",
      title: "Rooftop Rivals",
      type: "manga",
      author: "Mika Tanabe",
      year: 2020,
      status: "completed",
      genres: ["Romance", "Comedy"],
      hue: 350,
      description:
        "Two students who cannot stand each other keep claiming the same school rooftop for lunch. A truce, a shared umbrella and one very awkward festival later, they might be rivals for something else entirely.",
    },
    {
      count: 10,
      latestDaysAgo: 120,
      cadence: 14,
      pages: 13,
      titles: ["Lunch Break Wars", "A Truce, Maybe", "Shared Umbrella"],
    },
  ),
  series(
    {
      id: "ash-and-ember-academy",
      title: "Ash & Ember Academy",
      type: "manhwa",
      author: "Park Min-ah",
      year: 2024,
      status: "ongoing",
      genres: ["Fantasy", "School"],
      hue: 12,
      description:
        "Kael is the only student at the elite Ember Academy who cannot cast a single spell — which makes him the only one the Ash Court cannot read. Now every faction wants him, and he just wants to graduate.",
    },
    {
      count: 11,
      latestDaysAgo: 5,
      cadence: 7,
      pages: 11,
      titles: ["Entrance Exam", "The Spell-less", "Court of Ash", "Midterms"],
    },
  ),
  series(
    {
      id: "salt-road-chronicles",
      title: "Salt Road Chronicles",
      type: "manga",
      author: "Ryo Hanamura",
      year: 2018,
      status: "completed",
      genres: ["Historical", "Adventure"],
      hue: 38,
      description:
        "A caravan of misfits carries the last shipment of salt across a crumbling empire. Part road story, part political thriller, wholly about the people who keep walking when the map runs out.",
    },
    {
      count: 7,
      latestDaysAgo: 400,
      cadence: 30,
      pages: 15,
      titles: ["First Caravan", "Dust Toll", "The Salt Queen"],
    },
  ),
  series(
    {
      id: "midnight-delivery",
      title: "Midnight Delivery Service",
      type: "manhwa",
      author: "Lee Chae-won",
      year: 2023,
      status: "hiatus",
      genres: ["Urban Fantasy", "Comedy"],
      hue: 262,
      description:
        "Courier Jin delivers parcels between the human city and the one underneath it. The pay is terrible, the customers are worse, and the return address on the strangest package is his own.",
    },
    {
      count: 9,
      latestDaysAgo: 75,
      cadence: 7,
      pages: 10,
      titles: ["Return to Sender", "Underground Express", "Signature Required"],
    },
  ),
  series(
    {
      id: "glass-garden",
      title: "Glass Garden",
      type: "manga",
      author: "Emi Fujisawa",
      year: 2019,
      status: "completed",
      genres: ["Drama", "Slice of Life"],
      hue: 190,
      description:
        "After her grandmother's death, Aoi inherits a greenhouse that has never grown anything — and a ledger of letters addressed to people who no longer live in town. A quiet story about delivering words that arrived too late.",
    },
    {
      count: 6,
      latestDaysAgo: 300,
      cadence: 30,
      pages: 12,
      titles: ["The Ledger", "Unsent", "First Bloom"],
    },
  ),
];
