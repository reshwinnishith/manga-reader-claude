# Cloud sync: conflict semantics

`mergeUserData` (`src/services/sync-merge.ts`) decides what happens when two
copies of a library differ. It is pure and deterministic: merging A into B and B
into A gives the same result, and merging a result again changes nothing, so
devices converge in any order of sync. This is tested with 300 random pairs and
100 random triples (`sync-merge.test.ts`).

## Rules

| Data | Rule |
| --- | --- |
| **Reading status** | Per library entry, the newer change time wins. The time is `updatedAt` (set on add, status edit, and when reading moves a title to "reading"); entries saved before sync existed have none and use `addedAt`. Page turns never change it. Equal times pick the greater status string: arbitrary, but the same on every device. |
| **Deletion** | Removing a title records a tombstone (`seriesId -> deletedAt`). A tombstone removes an entry unless the entry changed *after* the deletion (a re-add, or a later status edit), in which case the entry stays and the tombstone is retired. Equal times: the deletion wins. Reading progress and saved metadata are kept when a title is deleted, so a re-added title still has its history. |
| **Chapter position** | The chapter record with the newer `updatedAt` decides `page`, `pageCount` and `atEnd`. Turning back a page is therefore not undone by an older, further position (the previous rule took the highest page). |
| **Chapter completion** | Sticky. If any copy finished a chapter it stays finished, the same rule `recordProgress` applies on one device ("never reverts"). A newer record that is not completed does not un-finish it. |
| **Mark unread** | **Not a supported operation today**, so no merge rule can undo completion. If the app adds it, it must be a recorded event, not an absence of data. See the design note below. |
| **Last chapter** | The series progress record with the newer `updatedAt` decides `lastChapterId`. |
| **Reader mode** | Per series, the newer choice wins (`readerModeTimes`). A mode with no time (chosen before sync existed) loses to any timestamped choice. Local no longer always wins. |
| **Saved titles** | The newer `fetchedAt` wins. |
| **Seeded flag** | True if either copy is seeded. |

## Existing data

Everything added is optional, so nothing is migrated destructively and no existing
library is rewritten: `LibraryEntry.updatedAt` and `UserData.readerModeTimes` are
absent on old data and the older fallbacks above apply. `migrateUserData` keeps
both when present and drops values that are not valid dates. The local
`pre-sync-backup` is taken before the first upload as before.

## Known limits

- **Clocks.** "Newer" trusts each device's clock. A device with a clock far ahead
  wins conflicts until the others catch up. Mitigation if it matters: reject or
  clamp timestamps ahead of server time (needs a server timestamp source).
- **Tombstones are kept forever** (about 60 bytes each, inside the size guard).
  Expiring them risks a long-offline device resurrecting deleted titles.
- **Per-record, not per-field.** A status edit on one device and a different
  status edit on another resolve to whichever is newer; there is no field-level
  merge inside a library entry.

## Design note: mark unread (not implemented)

Completion is a one-way flag today, so there is no way to say "this was un-read".
Supporting it needs one new optional field per chapter record, `unreadAt`
(ISO time). Merge would then treat a chapter as completed only if
`completedTime > unreadAt` (completion time being the chapter's `updatedAt` when it
was completed), and a later finish would clear it. That is a small, additive change
but also needs a product decision (what unread does to `page`, `atEnd` and series
status), so it is deliberately left for a separate request.
