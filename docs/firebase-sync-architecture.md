# Cloud sync architecture and decisions

Status: implemented behind two gates and **inactive by default**. Nothing syncs
unless the build has `NEXT_PUBLIC_FIREBASE_*` settings *and* the user clicks
"Enable Cloud Sync". No Firebase Console change, rules deployment or live
activation has been done.

## Data layout (`users/{uid}`)

- `snapshots/{id}` is an immutable, complete copy of the library
  (`isComplete: true`, `revision`, `checksum`). Libraries over ~900 KiB are split
  into `snapshots/{id}/parts/part_N`, each with its own checksum.
- `sync/userData` is the pointer: `revision`, `activeSnapshotId`,
  `snapshotChecksum`, `snapshotParts`.

## Write protocol

1. Read the **verified** remote state (see Recovery). If it cannot be read safely,
   stop: nothing is published and local data is untouched.
2. Merge deterministically with local data (`sync-conflict-semantics.md`).
3. Stage a new snapshot, read it back and verify checksums. On any failure the
   staged documents are deleted and the error is raised.
4. Publish in a transaction that fails unless the pointer is still at the revision
   that was read (compare-and-swap). The loser deletes its staged snapshot and
   retries from step 1 (3 retries, backoff).
5. Prune old snapshots in the background.

The Firestore rules enforce the same invariants server-side, so a buggy or old
client cannot break them (`firestore.rules`, tested against the real emulator):
revision must be `previous + 1`; the pointer must name an existing complete
snapshot whose revision, checksum and part count match; snapshots and parts are
create-only; the active snapshot (and its parts) cannot be deleted.

## Recovery (reading)

`loadRemoteState` verifies the active snapshot: complete, checksum matches the
pointer, every part present and consistent, each part checksum, and the checksum
of the assembled data. If that fails it tries the newest earlier snapshot that
verifies and reports the recovery; the next sync merges local data into it and
publishes a fresh verified snapshot. If none verifies, or the data was written by
a **newer app version**, it throws and sync stops. A missing or corrupt remote is
never treated as empty, and a transient network error is never treated as
corruption. Local storage is never overwritten except by merging verified remote
data into it; the pre-sync backup is kept.

## Concurrency inside a tab

`syncNow` is single-flight: one sync runs at a time and requests made meanwhile
join one follow-up that reads the freshest local data when it starts. Results are
applied by merging into whatever is stored at that moment, so edits made during a
sync are never overwritten. The live listener attaches once a user is signed in
(and re-attaches on sign-in, sign-out and opt-in), ignores echoes of the tab's own
writes, and never applies unverified data.

## Decisions taken in this pass

- **Secondary per-collection copies** (`library`, `progress`, `readerModes`,
  `savedTitles`): nothing in the app reads them and each sync rewrote every record
  into them, so they are off (`SECONDARY_REPLICAS_ENABLED = false`). The snapshot
  is the single source of truth. Rules and reconcile code remain for an owner who
  wants a human-readable export or server-side queries; that is a separate choice.
- **SDK weight:** the Firebase SDK was about 173 KB gzipped (roughly 40% of all
  client JavaScript) and shipped to every visitor. It now loads lazily, only when
  Firebase is configured and the user opted in
  (`persistence-factory.ts`, `sync-status-bridge.ts`). A build without Firebase
  settings never requests it.
- **Checksums** are SHA-256 over canonical (sorted-key) JSON, with a pure-JS
  fallback where `crypto.subtle` is unavailable. Sync data written by earlier
  commits of this unmerged branch is not readable (no live data exists).

## Google sign-in with safe account linking (wired, inert until sync is enabled)

`signInWithGoogleSafely` (`firebase-auth.ts`) is reached only through the
**Sign in with Google** button, which appears only when Firebase is configured and
the user has opted in (`google-account.ts`, lazy). It needs the Google provider
enabled in the Firebase project (owner action). Before the account changes, a
backup is written and read back (`manga-reader:v1:pre-account-switch-backup`); if
that fails nothing is signed in. Queued syncs finish first. Revision tracking is
per account, so switching accounts cannot hide the new account's changes.
**Disable cloud sync** turns the opt-in off: the listener detaches, runs in progress
stop before their next cloud write (a staged snapshot is removed), and nothing is
deleted locally or remotely; the Firebase sign-in itself is kept.

- Anonymous user: `linkWithPopup`. The user ID is unchanged, so existing cloud
  data is kept and becomes reachable from other devices that sign in with the
  same Google account.
- Google account already linked elsewhere (`credential-already-in-use`): sign in
  to that account. This device's library is still whole in localStorage and merges
  into the account's snapshot on the next sync. The abandoned anonymous user's
  cloud copy stays in place.
- Popup closed/blocked/provider disabled/network errors change nothing.

To use: enable Google sign-in and add the site domain under authorized
domains; consider an admin task
that deletes anonymous users inactive for 30+ days (their data is merged into the
account or still on the device).

## Anonymous sign-in abuse exposure (not solved by code)

Anyone can create anonymous users and write within their own `users/{uid}`
subtree. Rules bound each document (1 MiB) and shape, but cannot cap how many
snapshots a user creates or how many users exist, so a scripted client could run
up storage and write costs. The rules do keep users out of each other's data.
Recommended before turning sync on (all owner actions, none done here):

1. Enable **Firebase App Check** (reCAPTCHA Enterprise or v3) and enforce it for
   Firestore and Auth.
2. Set a **budget alert** and Firestore quotas on the project.
3. Prefer Google sign-in over anonymous for sync, and expire stale anonymous users.
4. Keep the Spark (free) plan, which cannot incur charges.

## Running the checks

- `npm run check` runs typecheck, lint, all unit tests and the build. The Firestore
  rules tests need an emulator and are **skipped** (with a warning) if none is
  reachable, so they are never counted as passing there.
- `npm run test:rules` starts the Firestore emulator (needs Java 11+) and runs
  them. `npm run test:rules:ci` does the same but **fails instead of skipping** if
  the emulator is unavailable; the `firestore-rules` job in
  `.github/workflows/phase1-checks.yml` uses it.
