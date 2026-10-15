/** The user's explicit opt-in to cloud sync. SDK-free; stored per browser. */
export const CLOUD_SYNC_OPT_IN_KEY = "manga-reader:v1:cloud-sync-enabled";

const subscribers = new Set<() => void>();

export function isCloudSyncEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CLOUD_SYNC_OPT_IN_KEY) === "true";
  } catch {
    return false;
  }
}

/** Updates the opt-in preference and tells subscribers (listener, lazy adapter, UI). */
export function setCloudSyncEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLOUD_SYNC_OPT_IN_KEY, enabled ? "true" : "false");
  } catch (e) {
    console.warn("Failed to set cloud sync opt-in preference:", e);
  }
  subscribers.forEach((notify) => notify());
}

export function subscribeCloudSyncPreference(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}
