import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { library } from "@/test/sync-fixtures";

const state = vi.hoisted(() => ({
  configured: true,
  order: [] as string[],
  signIn: null as null | (() => Promise<unknown>),
  syncOutcome: { ok: true } as { ok: boolean },
}));

vi.mock("./firebase-config", () => ({ isFirebaseConfigured: () => state.configured, getFirebaseConfigFromEnv: () => ({}) }));
vi.mock("./firebase-auth", () => ({
  signInWithGoogleSafely: () => { state.order.push("signIn"); return state.signIn!(); },
  getCurrentUser: () => null,
  subscribeToAuthState: () => () => undefined,
}));
vi.mock("./firestore-sync", () => ({
  syncService: {
    whenIdle: async () => { state.order.push("idle"); },
    syncNow: async () => { state.order.push("sync"); return state.syncOutcome; },
  },
}));

import { CLOUD_SYNC_OPT_IN_KEY } from "./cloud-sync-preference";
import { ACCOUNT_SWITCH_BACKUP_KEY, connectGoogleAccount, createAccountSwitchBackup } from "./google-account";

const code = (c: string) => Object.assign(new Error(c), { code: c });
const local = library(3);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, "true");
  state.configured = true;
  state.order = [];
  state.syncOutcome = { ok: true };
  state.signIn = async () => ({ status: "linked" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("connectGoogleAccount", () => {
  it("links an anonymous account: backs up first, waits for running syncs, signs in, then syncs", async () => {
    const result = await connectGoogleAccount(() => local);
    expect(result.status).toBe("linked");
    expect(state.order).toEqual(["idle", "signIn", "sync"]);
    const backup = JSON.parse(localStorage.getItem(ACCOUNT_SWITCH_BACKUP_KEY)!);
    expect(backup.data).toEqual(local); // backup existed before sign-in and matches the library
  });

  it("reports an account that is already signed in with Google, and an existing cloud account that was merged", async () => {
    state.signIn = async () => ({ status: "already" });
    expect((await connectGoogleAccount(() => local)).status).toBe("already");
    state.signIn = async () => ({ status: "signed-in", previousAnonymousUid: "anon" });
    const switched = await connectGoogleAccount(() => local);
    expect(switched.status).toBe("signed-in");
    expect(switched.message).toMatch(/merged/);
  });

  it("does nothing, and says why, when the backup cannot be verified", async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === ACCOUNT_SWITCH_BACKUP_KEY) throw new Error("quota");
      return original.call(this, key, value);
    });
    const result = await connectGoogleAccount(() => local);
    expect(result.status).toBe("no-backup");
    expect(state.order).not.toContain("signIn");
    expect(state.order).not.toContain("sync");
  });

  it("treats a closed or superseded popup as a quiet cancellation: nothing syncs, nothing changes", async () => {
    for (const c of ["auth/popup-closed-by-user", "auth/cancelled-popup-request"]) {
      state.order = [];
      state.signIn = async () => { throw code(c); };
      const result = await connectGoogleAccount(() => local);
      expect(result.status).toBe("cancelled");
      expect(state.order).not.toContain("sync");
    }
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["auth/popup-blocked", /pop-ups/],
    ["auth/network-request-failed", /connection/],
    ["auth/unauthorized-domain", /authorized/],
    ["auth/operation-not-allowed", /not enabled/],
    ["auth/internal-error", /unchanged/],
  ])("explains %s without losing anything", async (c, text) => {
    state.signIn = async () => { throw code(c); };
    const result = await connectGoogleAccount(() => local);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(text);
    expect(state.order).not.toContain("sync");
  });

  it("still succeeds, with a safe-offline note, when the follow-up sync fails", async () => {
    state.syncOutcome = { ok: false };
    const result = await connectGoogleAccount(() => local);
    expect(result.status).toBe("linked");
    expect(result.message).toMatch(/safe on this device/);
  });

  it("refuses when sync is off or Firebase is not configured, without touching auth or storage", async () => {
    localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, "false");
    expect((await connectGoogleAccount(() => local)).status).toBe("disabled");
    localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, "true");
    state.configured = false;
    expect((await connectGoogleAccount(() => local)).status).toBe("disabled");
    expect(state.order).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_SWITCH_BACKUP_KEY)).toBeNull();
  });

  it("does not sync if sync was switched off while the popup was open", async () => {
    state.signIn = async () => { localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, "false"); return { status: "linked" }; };
    expect((await connectGoogleAccount(() => local)).status).toBe("disabled");
    expect(state.order).not.toContain("sync");
  });
});

describe("createAccountSwitchBackup", () => {
  it("round-trips exactly and replaces the previous account-switch backup", () => {
    expect(createAccountSwitchBackup(library(2))).toBe(true);
    expect(createAccountSwitchBackup(library(4))).toBe(true);
    expect(Object.keys(JSON.parse(localStorage.getItem(ACCOUNT_SWITCH_BACKUP_KEY)!).data.library)).toHaveLength(4);
  });
});
