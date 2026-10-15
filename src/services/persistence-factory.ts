import type { UserData } from "@/domain/types";
import { isCloudSyncEnabled, subscribeCloudSyncPreference } from "./cloud-sync-preference";
import { isFirebaseConfigured } from "./firebase-config";
import { createLocalStorageAdapter, type PersistenceAdapter } from "./persistence";

/**
 * The persistence adapter the app runs on. It is plain localStorage unless cloud
 * sync is both configured and opted into; only then is the cloud-sync module (and
 * with it the Firebase SDK, ~170 KB gzipped) downloaded. A build without Firebase
 * settings never fetches it, and neither does a user who has not enabled sync.
 *
 * Edits made before the module arrives are saved locally as usual; the first
 * sync then reads the freshest local data, so nothing is skipped.
 */
export function createAppPersistenceAdapter(local: PersistenceAdapter = createLocalStorageAdapter()): PersistenceAdapter {
  if (!isFirebaseConfigured()) return local;

  let synced: PersistenceAdapter | null = null;
  let loading = false;
  let externalChange: (() => void) | null = null;
  let unsubscribeSynced: (() => void) | null = null;
  // The synced adapter writes through this view, so change notifications are not delivered twice.
  const writeThrough: PersistenceAdapter = {
    load: () => local.load(),
    save: (data: UserData) => local.save(data),
    getWarning: () => local.getWarning?.(),
    getRecovery: () => local.getRecovery?.(),
  };

  const attach = () => {
    if (synced || loading || typeof window === "undefined" || !isCloudSyncEnabled()) return;
    loading = true;
    void import("./firestore-sync")
      .then(({ createSyncedPersistenceAdapter }) => {
        synced = createSyncedPersistenceAdapter(writeThrough);
        synced.load(); // starts the first sync
        if (externalChange) unsubscribeSynced = synced.subscribe?.(externalChange) ?? null;
      })
      .catch((error: unknown) => console.warn("Cloud sync could not be loaded; continuing with local storage only:", error))
      .finally(() => {
        loading = false;
      });
  };

  return {
    getWarning: () => local.getWarning?.(),
    getRecovery: () => local.getRecovery?.(),
    load() {
      const data = local.load();
      attach();
      return data;
    },
    save(data) {
      if (synced) synced.save(data);
      else local.save(data);
    },
    subscribe(onExternalChange) {
      externalChange = onExternalChange;
      const unsubscribeLocal = local.subscribe?.(onExternalChange) ?? (() => {});
      const unsubscribePreference = subscribeCloudSyncPreference(attach);
      unsubscribeSynced = synced?.subscribe?.(onExternalChange) ?? null;
      return () => {
        externalChange = null;
        unsubscribeLocal();
        unsubscribePreference();
        unsubscribeSynced?.();
        unsubscribeSynced = null;
      };
    },
  };
}
