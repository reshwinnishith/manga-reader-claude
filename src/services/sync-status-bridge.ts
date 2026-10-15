import { subscribeCloudSyncPreference, isCloudSyncEnabled } from "./cloud-sync-preference";
import { isFirebaseConfigured } from "./firebase-config";

/**
 * Sync status shared with the UI without importing the Firebase SDK. The sync
 * service (loaded lazily) publishes here; components only read.
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error" | "disabled";

let raw: SyncStatus = "idle";
let notice: string | undefined;
const listeners = new Set<(status: SyncStatus) => void>();

/** What the user should see: "disabled" unless Firebase is configured and they opted in. */
export function getSyncStatus(): SyncStatus {
  return isFirebaseConfigured() && isCloudSyncEnabled() ? raw : "disabled";
}

export function getSyncNotice(): string | undefined {
  return notice;
}

export function publishSyncState(next: { status?: SyncStatus; notice?: string | undefined }): void {
  const before = getSyncStatus();
  if (next.status !== undefined) raw = next.status;
  if ("notice" in next) notice = next.notice;
  if (getSyncStatus() !== before || "notice" in next) listeners.forEach((l) => l(getSyncStatus()));
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  const unsubscribePreference = subscribeCloudSyncPreference(() => listener(getSyncStatus()));
  listener(getSyncStatus());
  return () => {
    listeners.delete(listener);
    unsubscribePreference();
  };
}
