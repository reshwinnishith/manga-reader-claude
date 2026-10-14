# Manga Reader

A personal manga/manhwa reading PWA. **Open → Find → Read → Resume.**

This is **Checkpoint 1.5** (Checkpoint 1 plus reading-progress reliability, chapter continuation, On Hold / Dropped statuses and iPhone polish): a complete, fully local prototype. There is no Firebase, no authentication, no
network calls to manga sources, and no deployment. All content is mock data with generated placeholder
artwork (no copyrighted images). Reading progress and your library live in the browser's `localStorage`.

## Features

| Screen | What it does |
| --- | --- |
| **Home** | Continue Reading hero (resumes at the exact chapter and page), more in progress, New Chapters, Recently Added |
| **Library** | Cover grid, search, status filters (All / Reading / Planned / On Hold / Dropped / Completed), empty states |
| **Discover** | Search + Manga/Manhwa filter over a mock catalog, one-tap add/remove from library |
| **Series** | Cover, metadata, description, progress, Start/Continue button, chapter list with read/in-progress state, reading status |
| **Reader** | Full-screen, tap to show/hide controls, page slider, previous/next chapter. **Vertical scroll** (manhwa default) and **paged right-to-left** (manga default). Mode is remembered per series. Progress is saved on every page change and the next chapter is one tap away |

Reader controls:

- **Paged (RTL):** tap the left third = next page, right third = previous page, centre = controls. Swipe right = next page. Keyboard: ← next, → previous, Space next, Shift+Space previous.
- **Vertical:** scroll; tap anywhere to toggle controls (they auto-hide while scrolling).
- `Esc` toggles controls in both modes.

### Reading progress semantics

The reader tracks one position per chapter, `index`: `0 … pageCount-1` are pages and `pageCount` means **the end of the chapter**. Both modes read and write this same value, so mode switches, going backwards and reopening cannot disagree.

| Term | Meaning |
| --- | --- |
| `page` | Last page viewed (never past the final page) |
| `atEnd` | The *current* position is the end of the chapter. Paged: the end card is showing. Vertical: the final page's bottom edge has scrolled past the middle of the screen |
| `completed` | The end was reached at least once. **Sticky**: rereading, scrolling back or switching modes never clears it |

- Being on the **final page does not complete** a chapter; reaching the end does. The slider cannot reach the end.
- Stepping back off the end clears `atEnd` only. Recording an unchanged position is a no-op, so repeated events cannot duplicate completions.
- **Resume / Continue:** nothing read → chapter 1; otherwise the last-read chapter at its saved page; if it was left `atEnd`, the next chapter (at its saved page if partly read, else the top); at the end of the latest chapter → "caught up".
- **Opening a chapter:** where you left off, or the top if it was unread or left at its end.
- **Chapter continuation:** the end card offers "Continue to next chapter". In paged mode one more forward tap/swipe/key on the end card also continues, ignored for 450 ms after arriving so a double tap cannot skip a chapter. Footer previous/next-chapter controls always work.
- **Caught up:** on the latest chapter the end card says so (or "The end" for a finished series) and offers Back to series; the series page shows "Caught up · Read again".
- **Library status side effects:** reading moves Planned / On Hold / Dropped series back to Reading; finishing every chapter of a publication-complete series sets Completed; rereading a Completed series leaves it Completed. On Hold and Dropped series are kept off Home (Continue Reading, New Chapters, Recently Added) but stay in the Library.

### Stored data & migration

User data is versioned (`UserData.version`, currently 2). `migrateUserData` upgrades older data on load, keeps everything (library, progress, modes, completion history), derives `atEnd` for v1 chapters, and falls back to "reading" for unknown statuses. The v1 original is copied once to `manga-reader:v1:backup-v1` before the upgraded copy is written. Add a step there when the shape changes again.

## Getting started

Requires Node 20.9+ (developed on Node 22).

```bash
npm install
npm run dev        # http://localhost:3000 (also listens on your LAN)
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest (unit + component tests)
npm run build      # production build
npm start          # serve the production build
npm run check      # typecheck + lint + test + build
```

## Previewing on an iPhone

**Same Wi-Fi (quickest):**

1. On your Mac/PC run `npm run dev` (or `npm run build && npm start` for the production build).
2. Find the computer's LAN address: macOS → `ipconfig getifaddr en0`, or System Settings → Wi-Fi → Details.
3. On the iPhone open Safari and go to `http://<that-ip>:3000`.
4. For the full-screen app experience: Share → **Add to Home Screen**. It launches standalone with the dark status bar and no browser chrome.

If the page does not load, check that both devices are on the same network and that the firewall allows incoming connections for Node. `next.config.ts` already allows common private LAN ranges (`192.168.*.*`, `10.*.*.*`, `172.*.*.*`) and `*.local` names for the dev server; add your own hostname to `allowedDevOrigins` if you use something else.

**Over HTTPS / off your network (optional):** expose the local server with a tunnel you already trust (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and open the URL on the phone. Not required for Checkpoint 1.

Notes: iOS only treats an installed PWA as standalone when added from Safari. Data is stored per origin, so progress made at `http://192.168.x.x:3000` is separate from progress made on `localhost` or a future deployed URL.

## Architecture

```
src/
  app/                    Next.js App Router
    layout.tsx            Root layout: metadata/viewport, loads catalog via ContentSource
    (app)/                Browsing shell (bottom tabs on phones, side rail >= 900px)
      page.tsx            Home
      library/ discover/ series/[id]/
    read/[seriesId]/[chapterId]/   Reader (outside the shell: no nav, full screen)
    manifest.ts           PWA manifest
    icons/[name]/route.tsx  Icons rendered at build time (no binary assets)
  domain/types.ts         Series, Chapter, UserData ... plain serialisable data
  data/                   Mock catalog + first-run demo library
  services/
    content-source.ts     ContentSource interface (where series/chapters come from)
    mock-content-source.ts
    persistence.ts        PersistenceAdapter interface + localStorage / memory adapters
  lib/
    user-data.ts          Pure state transitions (add to library, record progress ...)
    selectors.ts          Pure derivations (resume target, new chapters, filters ...)
    placeholder.ts        Deterministic generator for placeholder art
  state/
    user-data-store.ts    Tiny external store (useSyncExternalStore) over a PersistenceAdapter
    use-user-data.ts      React hook; null until client data has loaded
    catalog-context.tsx   Server-loaded catalog handed to client components
  components/             Views, reader, UI primitives
```

Key decisions:

- **Static where possible.** Catalog pages are pre-rendered from the `ContentSource`; user-specific state is client-only, so pages render a skeleton first and fill in from storage (no hydration mismatches).
- **Pure core, thin shell.** All progress/library rules are pure functions (`lib/user-data.ts`, `lib/selectors.ts`) taking `now` as an argument, so they are deterministic and heavily unit-tested.
- **Resume rules** (`getResumeTarget`): nothing read → chapter 1; mid-chapter → same page; reached the last page → next chapter from the top; everything finished → "Read again". Reaching a chapter's last page marks it completed (and it stays completed on re-read).
- **A fixed mock clock** (`MOCK_NOW` in `data/mock-catalog.ts`) makes "New Chapters" deterministic across server, client and tests. A real source adapter will use the real clock.
- **Per-series reader mode** is stored with the user data; the default comes from the series type (manhwa → vertical, manga → paged RTL).

### Where later integrations plug in

| Future work | Seam |
| --- | --- |
| Firebase Firestore + cross-device sync | Implement `PersistenceAdapter` (`services/persistence.ts`). Every record already carries `updatedAt`/`addedAt` for merge-by-timestamp; `createUserDataStore` takes the adapter as an argument |
| Managed authentication | Wrap the app in an auth provider and select the adapter per signed-in user; the store and UI do not change |
| Multiple permitted sources | Implement `ContentSource` per source and compose them in `services/mock-content-source.ts` (`contentSource`); pages only depend on the interface |
| Verified series/chapter equivalence | Add a canonical id + `sources[]` mapping to `Series`/`Chapter` and resolve it inside a composite `ContentSource`; progress keys on canonical ids |
| Translation/source preferences | Extend `UserData` (e.g. `preferences`) and have the composite source honour them |
| Offline reading/caching | Add a service worker and have page sources return URLs instead of generated placeholders (`PlaceholderPage` is the only page renderer) |
| Mac mini worker | Reads/writes the same Firestore documents later; no app changes needed |

## Testing

`npm test` runs Vitest with Testing Library (jsdom):

- `lib/user-data.test.ts`, `lib/selectors.test.ts`, `lib/reader-position.test.ts`: library statuses, completion boundaries, idempotence, rereading, resume rules, v1→v2 migration, Home filtering, search
- `state/user-data-store.test.ts`: localStorage persistence across "reloads", v1 migration + backup, corrupt data recovery, no reseeding, multi-tab updates, no-op writes
- `components/app-nav.test.tsx`: navigation links and active state
- `components/screens.test.tsx`: Home, Library, Discover (add to library) and Series (Start/Continue) behaviour and empty states
- `components/reader-view.test.tsx`: paged taps/swipes/keyboard, end-of-chapter completion in both modes (with a fake-layout vertical scroll), chapter transitions and the skip guard, caught-up states, rereading, mode switching, per-series mode, error state

### What is and is not verified on an iPhone

- **Automated (run in this repo):** the Vitest suite above, plus a Chromium script with iPhone viewport/UA/touch emulation that checked real touch gestures (tap zones, RTL swipes, vertical drag scrolling), tap targets ≥ 44 px on every screen, safe-area handling (by overriding the `--safe-*` CSS variables to notch-sized values), navigation, v1→v2 migration in a real browser and reload restoration.
- **Not covered:** actual iPhone Safari / WebKit. No WebKit engine was available, so Safari-specific behaviour (dynamic toolbar resizing, real `env(safe-area-inset-*)`, momentum scrolling, the edge-swipe back gesture, home-screen install) still needs a manual pass on a device using the steps above.

## PWA

`app/manifest.ts` provides the web app manifest (standalone, dark theme colour, icons incl. maskable). Icons are generated at build time from `app/icons/[name]/route.tsx`. iOS meta tags (`apple-mobile-web-app-*`, safe-area handling with `viewport-fit=cover`) are configured. A service worker is intentionally **not** included yet; it arrives with offline reading in a later checkpoint.

## Known limitations (Checkpoint 1)

- Mock data only; placeholder pages are generated vector art, not real chapters.
- Progress is per browser/origin (no sync, no accounts).
- No service worker, so no offline support beyond the browser cache.
- Paged mode is single-page; no two-page spread for landscape/desktop yet.
- No page-turn animation or pinch-zoom in the reader.
- Demo data is seeded on first launch; clear site data to reset.
- Completion in vertical mode is a scroll-position heuristic (final page's bottom edge past mid-screen); with very different page heights it may need tuning once real images exist.
- Safari's left-edge swipe-back can fire if a paged swipe starts within ~20 px of the screen edge; tap zones avoid this. It does not apply to the installed home-screen app.
