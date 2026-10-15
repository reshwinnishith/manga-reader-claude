/* Browser check of the cloud-sync opt-in boundary. Needs Playwright's Chromium and a running
 * production build (`next start`). It uses an isolated browser profile and disposable data, and
 * BLOCKS every request that leaves localhost, so it can never reach any Firebase/Google project.
 *
 *   MODE=unconfigured  build without NEXT_PUBLIC_FIREBASE_*: the SDK must never load, no sync UI.
 *   MODE=configured    build with dummy Firebase settings (project "demo-smoke"): the SDK must not
 *                      load before opt-in; after the opt-in click it loads, its (blocked) network
 *                      calls fail safely, and the local library and a pre-sync backup are intact.
 */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_BASE_URL || "http://localhost:3102";
const mode = process.env.MODE || "configured";
const STORAGE_KEY = "manga-reader:v1";
const t = "2026-10-01T00:00:00.000Z";
const seed = JSON.stringify({
  version: 3,
  library: { "smoke-1": { seriesId: "smoke-1", status: "reading", addedAt: t, updatedAt: t } },
  progress: { "smoke-1": { lastChapterId: "c1", updatedAt: t, chapters: { c1: { page: 4, pageCount: 20, atEnd: false, completed: false, updatedAt: t } } } },
  readerModes: {}, savedTitles: {}, tombstones: {}, seeded: true,
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const blocked = [];
const sdkChunks = [];
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
  blocked.push(url.hostname);
  return route.abort();
});
page.on("response", async (response) => {
  const url = response.url();
  if (!url.includes("/_next/static/") || !url.endsWith(".js")) return;
  try {
    const body = await response.text();
    if (body.includes("identitytoolkit.googleapis.com") || body.includes("firestore.googleapis.com")) sdkChunks.push(url);
  } catch { /* response body unavailable (redirect/cached) */ }
});
await page.addInitScript(([key, value]) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, [STORAGE_KEY, seed]);

try {
  await page.goto(`${base}/library`, { waitUntil: "networkidle" });
  assert.equal(sdkChunks.length, 0, `Firebase SDK loaded before opt-in: ${sdkChunks}`);
  assert.deepEqual(blocked, [], `unexpected external requests before opt-in: ${blocked}`);
  const enable = page.getByRole("button", { name: "Enable Cloud Sync" });
  if (mode === "unconfigured") {
    assert.equal(await enable.count(), 0, "sync UI must not appear without Firebase settings");
    console.log("PASS unconfigured: no sync UI, SDK never loaded, no external requests");
  } else {
    await enable.waitFor({ timeout: 10000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("manga-reader:v1:cloud-sync-enabled")), null, "opt-in must be off by default");
    const before = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
    await enable.click();
    await page.waitForFunction(() => document.querySelector(".sync-status [role=status]")?.textContent?.match(/Offline|error|synced/i), null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.ok(sdkChunks.length > 0, "SDK should load after the opt-in click");
    assert.equal(await page.evaluate(() => localStorage.getItem("manga-reader:v1:cloud-sync-enabled")), "true");
    const after = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY));
    assert.deepEqual(after.library, JSON.parse(before).library, "local library changed by a failed sync");
    assert.equal(after.progress["smoke-1"].chapters.c1.page, 4, "reading progress changed by a failed sync");
    const status = await page.locator(".sync-status [role=status]").innerText();
    assert.match(status, /Offline|error/i, `a blocked network must not report "synced": ${status}`);
    const backup = await page.evaluate(() => localStorage.getItem("manga-reader:v1:pre-sync-backup"));
    console.log(`PASS configured: SDK lazy (${sdkChunks.length} chunk), status="${status}", library+progress intact, pre-sync backup ${backup ? "present" : "not created (sync never reached the cloud)"}, blocked hosts: ${[...new Set(blocked)].join(", ")}`);
    // Reload behaviour and opt-out: Google sign-in is offered while opted in; Disable stops everything,
    // keeps local data, and a reload afterwards loads no SDK.
    await page.getByRole("button", { name: "Sign in with Google" }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Disable cloud sync" }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("manga-reader:v1:cloud-sync-enabled")), "false");
    assert.equal(await page.getByRole("button", { name: "Sign in with Google" }).count(), 0, "Google sign-in must disappear when sync is off");
    const blockedBeforeReload = blocked.length;
    sdkChunks.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(sdkChunks.length, 0, "SDK loaded after reload with sync disabled");
    assert.equal(blocked.length, blockedBeforeReload, "network activity after reload with sync disabled");
    assert.deepEqual(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).library, JSON.parse(before).library);
    assert.ok(await page.getByRole("button", { name: "Enable Cloud Sync" }).isVisible(), "opt-in must be offered again");
    console.log("PASS opt-out: Google sign-in + Disable shown while opted in; after Disable and reload: no SDK, no network, library intact");
    for (const host of blocked) assert.ok(/googleapis\.com$|firebaseapp\.com$|firebaseio\.com$/.test(host), `unexpected external host ${host}`);
  }
} finally {
  await browser.close();
}
