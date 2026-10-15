# Source permissions for in-app reading

MangaReader shows page images in-app **only when a reviewed permission entry
affirmatively covers the edition**. The default is deny. Without an entry a
release is shown as an official external link (when the source lists one) or is
withheld and counted; its pages are never requested.

Code: `src/services/source-policy.ts` (`READING_PERMISSIONS`, `classifyRelease`).
The registry is **empty**: no source has been verified as permitting in-app
reading.

## What does *not* grant permission

- Missing licensing metadata (e.g. no `links.engtl` on the source record).
- An upload group, whether named, marked `official`, anonymous (`/a/nonymous`)
  or labelled "Ex-License". A group credit is attribution, not a licence.
- Official publisher chapters (MangaPlus, VIZ, Kodansha…) appearing in the same
  feed. They stay listed as link-outs; they say nothing about other uploads.
- The chapter or image endpoint currently returning images.
- A source's API terms of use, which govern API access, not redistribution of a
  specific work.

## What an entry requires

```ts
{
  providerId: "mangadex",
  mangaId: "<exact source edition UUID>",
  groups: ["Named group"],            // optional; narrows the grant
  basis: "publisher-license" | "rights-holder-consent" | "public-domain",
  evidenceUrl: "https://…",           // record of the permission
  reviewedBy: "name",
  reviewedAt: "YYYY-MM-DD",
  expiresAt: "YYYY-MM-DD",            // optional
}
```

Entries that are incomplete, future-dated, expired, non-https or for another
edition grant nothing (`isValidPermission`). The permission must be compatible
with MangaReader's use: personal, non-commercial, no offline copies, credit kept.

## Restrictions that still apply with an entry

- External-only and unavailable releases are never readable in-app.
- Uploads with no credited group are withheld.
- English uploads of an edition the catalogue records as officially licensed in
  English (`links.engtl`) are withheld. An entry cannot override that.

## Enforcement points

The chapter list (`summarizeReleases`), the chapter route (`chapterIdentity`),
and the page-image route (`assertChapterReadable`) all use the same check, so a
disallowed chapter cannot be opened by URL: no page manifest or image is
requested and the reader saves no progress.

## Reader navigation

Previous/next (`readerNeighbors`) only visits chapters readable in-app. Duplicate
numbers are collapsed by `selectChapters`: readable first, then the chapter being
read, then the newest upload, then id, independent of feed order. Different
volumes, decimal chapters and numberless specials are kept as separate content.
