import type { UserData } from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";
import { isCloudSyncEnabled } from "./cloud-sync-preference";
import { isFirebaseConfigured } from "./firebase-config";
import { canonicalStringify } from "./sync-snapshot";
import { getCurrentUser, signInWithGoogleSafely, subscribeToAuthState } from "./firebase-auth";
import { syncService } from "./firestore-sync";

/**
 * "Sign in with Google" for an opted-in user, loaded lazily with the rest of the
 * cloud-sync code. It never discards data:
 *
 * 1. A verified backup of this device's library is written first; if it cannot
 *    be written and read back identically, nothing is signed in.
 * 2. Pending syncs finish before the account changes, so no run straddles two accounts.
 * 3. `signInWithGoogleSafely` upgrades the anonymous account in place (same user
 *    ID), or, when the Google account already has cloud data, signs in to it.
 * 4. A sync then merges this device's library with that account's snapshot
 *    deterministically (see docs/sync-conflict-semantics.md); local data is
 *    kept in localStorage throughout and the old anonymous copy is left untouched.
 */
export const ACCOUNT_SWITCH_BACKUP_KEY = "manga-reader:v1:pre-account-switch-backup";

export type GoogleConnectResult =
  | { status: "linked" | "signed-in" | "already"; message: string }
  | { status: "cancelled" | "disabled" | "failed" | "no-backup"; message: string };

/** Writes `{ savedAt, data }` and reads it back; true only if it round-trips exactly. */
export function createAccountSwitchBackup(data: UserData, now = new Date().toISOString()): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(ACCOUNT_SWITCH_BACKUP_KEY, JSON.stringify({ savedAt: now, version: USER_DATA_VERSION, data }));
    const readBack = window.localStorage.getItem(ACCOUNT_SWITCH_BACKUP_KEY);
    if (!readBack) return false;
    const parsed = JSON.parse(readBack) as { version?: number; data?: unknown };
    return parsed.version === USER_DATA_VERSION && canonicalStringify(parsed.data) === canonicalStringify(data);
  } catch (error) {
    console.warn("Account-switch backup failed:", error);
    return false;
  }
}

const CANCELLED = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/user-cancelled"]);

function describeError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  switch (code) {
    case "auth/popup-blocked":
      return "The sign-in window was blocked. Allow pop-ups for this site and try again.";
    case "auth/network-request-failed":
      return "No connection. Try again when you are online.";
    case "auth/unauthorized-domain":
      return "This site's address is not authorized for Google sign-in in the Firebase project.";
    case "auth/operation-not-allowed":
      return "Google sign-in is not enabled for this Firebase project.";
    default:
      return "Google sign-in failed. Your library on this device is unchanged.";
  }
}

export async function connectGoogleAccount(getLocal: () => UserData): Promise<GoogleConnectResult> {
  if (!isFirebaseConfigured() || !isCloudSyncEnabled()) {
    return { status: "disabled", message: "Turn on cloud sync before signing in." };
  }
  try {
    await syncService.whenIdle();
    if (!createAccountSwitchBackup(getLocal())) {
      return { status: "no-backup", message: "Could not save a safety copy of your library, so nothing was changed." };
    }
    const result = await signInWithGoogleSafely();
    if (!isCloudSyncEnabled()) return { status: "disabled", message: "Cloud sync was turned off." };
    const outcome = await syncService.syncNow(getLocal);
    const synced = outcome.ok;
    const suffix = synced ? "" : " Syncing will retry; your library is safe on this device.";
    if (result.status === "already") return { status: "already", message: "Already signed in with Google." + suffix };
    if (result.status === "linked") return { status: "linked", message: "Google account linked. Your library is backed up to it." + suffix };
    return { status: "signed-in", message: "Signed in. Your cloud library was merged with this device's library." + suffix };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (CANCELLED.has(code)) return { status: "cancelled", message: "Sign-in cancelled. Nothing changed." };
    console.warn("Google sign-in failed:", error);
    return { status: "failed", message: describeError(error) };
  }
}

/** Calls back with whether the signed-in Firebase user has Google linked; returns the unsubscribe. */
export function watchGoogleLinked(onChange: (linked: boolean) => void): () => void {
  const linked = () => Boolean(getCurrentUser()?.providerData.some((p) => p.providerId === "google.com"));
  return subscribeToAuthState(() => onChange(linked()));
}
