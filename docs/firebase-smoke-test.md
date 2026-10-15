# Real Firebase smoke test: preparation, procedure and owner checklist

Nothing here touches a live Firebase project by itself. Everything under "Automated
(no live project)" runs in CI or locally; everything under "Live procedure" is for the
project owner, against a **disposable test Firebase project** (never the one that will
hold real libraries) and **disposable browser profiles / Google test accounts**.

## What runs without the live project (and is run)

| Area | How | Where |
| --- | --- | --- |
| Rules (51 tests): isolation, CAS revisions, active-snapshot protection | Firestore emulator, real rules | `npm run test:rules:ci` |
| Real client vs real rules (12 tests): publish, multi-part, pruning, race with re-pointing, concurrent writers, corruption recovery, **two-device convergence (library/status/reader mode/progress/deletion/re-add)**, **account isolation**, **offline edits merged on reconnect** | emulator | `firestore-sync.emulator.test.ts` |
| Merge semantics, migration, backup abort, opt-in gating, listener, queue | Vitest + in-memory Firestore | `npm run test` |
| SDK stays lazy; opt-in boundary; local data intact when the cloud is unreachable | Headless Chromium on a production build, **all non-localhost traffic blocked** | `scripts/verify-sync-lazy-load.mjs` |

Browser script usage (needs Playwright + a production build):

    # no Firebase settings: SDK never loads, no sync UI
    npm run build && npx next start -p 3102 &
    MODE=unconfigured TEST_BASE_URL=http://localhost:3102 node scripts/verify-sync-lazy-load.mjs
    # dummy settings (project "demo-smoke"): SDK loads only after the opt-in click
    NEXT_PUBLIC_FIREBASE_API_KEY=x NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-smoke.firebaseapp.com \
      NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-smoke NEXT_PUBLIC_FIREBASE_APP_ID=1:0:web:x npm run build
    MODE=configured TEST_BASE_URL=http://localhost:3103 node scripts/verify-sync-lazy-load.mjs

## What can only be proven live

Real Google sign-in and account linking, real anonymous sign-in, App Check, real SDK
networking/persistence, cross-device identity, deployed-rules behaviour, quota/billing.

## Known blockers before a live run

1. **No Google sign-in UI.** `signInWithGoogleSafely` is implemented and unit-tested but no
   screen calls it, so live steps 4-5 cannot be done from the app. Needs a small, approved
   UI change (a "Sign in with Google" action shown only for opted-in users).
2. **No App Check client code.** The app never initialises App Check. If App Check is
   *enforced* for Auth/Firestore in the Console, every request from this app is rejected.
   Use **unenforced (monitor) mode** for the first smoke test, or add the client first.
3. **No disable/opt-out button.** The only opt-out is clearing
   `manga-reader:v1:cloud-sync-enabled` (see procedure).
4. **No `.firebaserc`/deploy target** in the repo (intentional). Rules deployment is manual.

## Live procedure (owner, disposable test project)

Preconditions: owner checklist below done; build deployed to a **preview URL** (not
production) with the test project's `NEXT_PUBLIC_FIREBASE_*` values; two clean browser
profiles A and B (or two devices), each with a fresh disposable library. Use DevTools >
Application > Local Storage and Firebase Console > Firestore to observe. Record the
build commit SHA and time for every run.

1. **Anonymous auth.** Open the preview in profile A. Expect sync label "Local storage"
   and **no** Firebase network calls (Network tab: nothing to googleapis.com). Auth > Users
   shows no new user.
2. **Explicit opt-in.** Seed 3 disposable titles with progress. Click "Enable Cloud Sync".
   Expect: `manga-reader:v1:cloud-sync-enabled = "true"`, `pre-sync-backup` key created,
   one anonymous user appears, label "Cloud synced". Firestore: `users/{uid}/sync/userData`
   revision 1 and one `snapshots/*` doc with `isComplete: true`; no `library/` etc.
   subcollections (replicas are off).
3. **Local preservation.** Compare `manga-reader:v1` before/after: library and progress
   identical. Reload: still identical, still synced, no duplicate snapshots.
4. **Google linking** (after blocker 1): in A, link a Google test account. Expect the
   **same uid** (Auth > Users: the anonymous row gains a Google provider), data unchanged.
   Profile B (fresh): opt in, sign in with the same Google account -> B receives A's titles
   and progress; B's own pre-existing titles merge in, none lost.
5. **Synchronization.** In A: add a title, change status, turn pages, switch reader mode.
   In B (listener): changes appear without reload within seconds. Repeat B -> A.
6. **Offline.** Put A offline (DevTools > Network > Offline). Label "Offline (saved
   locally)". Make 2 edits. Meanwhile edit another title in B. Go online in A: expect A
   syncs, nothing lost on either side, revision increases, label "Cloud synced".
7. **Conflicts.** Offline in both: A deletes title X; B sets X to "completed" later.
   Reconnect both: B's later edit keeps X (see `docs/sync-conflict-semantics.md`). Repeat
   with the deletion later: X is gone on both. Page-turn on the same chapter in both: the
   later record wins; a finished chapter stays finished.
8. **Failure recovery & isolation.** (a) In Firestore, corrupt the active snapshot's
   `checksum`: next sync recovers from the previous snapshot and heals with a new revision.
   (b) Corrupt *all* snapshots: sync reports an error, **writes nothing**, local data intact.
   (c) Account isolation: with a second Google test account C, confirm C never sees A's
   data and, in the Rules Playground, that C cannot read `users/{A}/...`.
   (d) Opt out: remove the localStorage key and reload: no Firebase traffic.

Pass criteria: no step loses or duplicates local data; no step needs a rules or data
change made by hand other than the deliberate corruption in 8; Firestore usage stays
within the free tier.

## Firebase Console checklist (owner actions; not done by the code or by me)

1. **Project / web config.** Create a *separate test* project. Add a Web app. Put the six
   `NEXT_PUBLIC_FIREBASE_*` values in the Vercel *Preview* environment only (never
   Production, until approved). Rebuild the preview.
2. **Authentication.** Enable **Anonymous** and **Google** providers; set the support
   email. Authorized domains: add the preview hostname (and later the production one).
   Use a Google *test* account, not a personal one.
3. **Firestore.** Create the database (Native mode, closest region, production-mode rules).
4. **Rules.** Review `firestore.rules`, then publish it to the **test** project only
   (`firebase deploy --only firestore:rules --project <test-project>`, or paste in the
   Console). Run `npm run test:rules:ci` first. Do not publish to a project holding real data
   until the smoke test passes.
5. **App Check.** Register the web app (reCAPTCHA v3/Enterprise). Leave **unenforced** for
   Auth and Firestore until client code exists (blocker 2); only watch the metrics.
6. **Billing / limits.** Stay on the free Spark plan for the test. If Blaze is ever needed,
   first set a budget with alerts (e.g. 50/90/100 %) and a Firestore usage alert. Review
   Auth > Settings > user-account limits and the anonymous-user count after the run.
7. **Cleanup after the run.** Delete the test users and the `users/` collection, or the
   whole test project.
