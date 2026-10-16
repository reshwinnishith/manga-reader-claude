# Reading sources and edition identity

Verified on 14 October 2026. AniList supplies metadata, not chapter images.

## Provider boundary

`src/services/reading-source-types.ts` defines provider-neutral chapter metadata.
`src/services/reading-sources.ts` registers providers that resolve an exact edition
and supply their own chapter URL. The existing MangaDex adapter is the only
in-app transport currently integrated. Verified publisher links are separate from
in-app page availability. A new provider must document its public integration,
content permission, identity evidence, page transport and attribution. Do not
add a scraper, infer publisher URL slugs, copy publisher images, bypass a paywall,
or treat a title match as proof of identity or redistribution rights.

MangaDex API documentation: https://api.mangadex.org/docs/

Search aliases locate candidates; MangaDex's `links.al` must equal the AniList
ID before chapters are exposed. Multiple candidates claiming the same ID fail
closed. Author/artist metadata is retrieved and displayed for corroboration;
name similarity is not allowed to override a mismatched catalogue ID. Missing
identity links remain unmatched. This intentionally prefers false negatives over
unrelated editions. The reader re-resolves chapter → manga → AniList identity
server-side before recording progress; URL hints are not trusted evidence.

Discovery includes `safe` and `suggestive` ratings. A safe-only query excluded
the Murata edition even though AniList does not classify it as adult content.
AniList search continues excluding adult titles and novels.

Chapter feeds paginate until their reported total is reached. Stalled or
oversized pagination raises an error instead of pretending a partial result is
complete. The current MangaDex endpoint has a 10,000-offset bound; the app
reports that limitation. Chapter lists and source resolutions have bounded,
two-minute in-memory caches. These are performance caches, not offline downloads.

Release selection requires confirmed in-app readability before applying saved-ID
preference; unavailable, unknown and external-only saved releases cannot displace
a readable release. Within readable duplicates, a saved translation wins over a
newer translation regardless of feed order. Remaining ties use newest
publication and a stable ID. Numbered releases are deduplicated within a volume;
chapter zero and decimals remain valid. Numberless specials remain separate.
External-only and unavailable entries are visible but never sent to the image
reader. Translation attribution follows the actual selected release.

## One-Punch Man

Live MangaDex metadata returned:

| Edition | AniList ID | MangaDex ID | Credits |
| --- | --- | --- | --- |
| Murata manga | 74347 | d8a959f7-648e-4c8d-8f23-f1f3f8e129f3 | ONE / Murata Yuusuke |
| ONE webcomic | 85364 | b7d069cb-4ab9-4c21-a20b-38f7c269be4e | ONE / ONE |

The verified Murata edition's live English feed returned `total: 0`. Do not
replace it with the webcomic, fan-colored edition, crossover or doujinshi.

VIZ's page explicitly credits ONE and Yusuke Murata and lists official chapters:
https://www.viz.com/shonenjump/chapters/one-punch-man

The fallback is curated against AniList 74347 only. It does not assume the
reader's country is supported or that subscriptions/free chapters are available
in every region. No VIZ pages are copied into MangaReader.

MANGA Plus is an official publisher destination, but no documented permission
for redistributing its chapter images in this application was verified in this
sprint. It has not been added as an in-app transport:
https://mangaplus.shueisha.co.jp/terms_web/eng/

## Live readable-path verification

> Superseded for access decisions: this was a technical check that the transport
> works, not a permission. In-app reading is now default-deny; see
> [source-permissions.md](./source-permissions.md). Black Jack is not enabled.

Give My Regards to Black Jack (AniList 31668; MangaDex
9fca3c19-ac41-4ebf-8735-f4e3becc2b3e) returned 127 English chapters. Its first
chapter, 1369226a-5c75-4bbf-b385-d884228a9cfe, returned a 60-page manifest and
an HTTP 200 JPEG through the existing MangaDex@Home proxy. The actual feed
credits Manga Reborn (Ex-License); that credit is preserved in the reader.

Creator Shuho Sato discusses free secondary use of the original work here:
https://note.com/shuho_sato/n/neda36a41a7b3

This is evidence for selecting a real test title, not a blanket claim that every
translation or every MangaDex catalogue entry has publisher authorization.
MangaDex catalogue identity and image availability must not be presented as a
publisher license. New sources and broader curated fallbacks still need explicit
per-title/source permission evidence.
