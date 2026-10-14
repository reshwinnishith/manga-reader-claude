import type { UserData } from "@/domain/types";
import { migrateUserData } from "@/lib/user-data";

/**
 * Persistence boundary for user data. The app talks only to this interface, so
 * a Firestore-backed adapter (with merge-by-updatedAt sync) can replace or sit
 * alongside the local adapter without touching UI code.
 */
export interface PersistenceAdapter {
  load(): UserData | null;
  getWarning?(): string | undefined;
  save(data: UserData): void;
  /** Optional: notify when another tab/device changed the data. */
  subscribe?(onExternalChange: () => void): () => void;
}

export const STORAGE_KEY = "manga-reader:v1";

export function createLocalStorageAdapter(key = STORAGE_KEY): PersistenceAdapter {
  let canWrite = true;
  let warning: string | undefined;
  const unreadable = () => { canWrite = false; warning = "Existing saved data could not be read and has been preserved. Changes in this session cannot be saved. Export a backup before closing."; };
  return {
    getWarning: () => warning,
    load() {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        const migrated = migrateUserData(parsed);
        if (!migrated) { unreadable(); return null; } // preserve unreadable/future-version data
        const from = (parsed as { version?: unknown }).version;
        if (from !== migrated.version) {
          // Keep the pre-migration copy once, then persist the upgraded shape.
          const backupKey = `${key}:backup-v${String(from)}`;
          if (window.localStorage.getItem(backupKey) === null) window.localStorage.setItem(backupKey, raw);
          window.localStorage.setItem(key, JSON.stringify(migrated));
        }
        return migrated;
      } catch {
        unreadable();
        return null; // preserve corrupt or unavailable storage
      }
    },
    save(data) {
      if (!canWrite) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(data));
      } catch {
        warning = "Your browser could not save these changes. Keep this tab open and export a backup from Library.";
        // Quota or private-mode failure: keep working in memory.
      }
    },
    subscribe(onExternalChange) {
      const handler = (e: StorageEvent) => {
        if (e.key === key || e.key === null) onExternalChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}

export function createMemoryAdapter(initial: UserData | null = null): PersistenceAdapter {
  let stored = initial;
  return {
    load: () => stored,
    save: (data) => {
      stored = data;
    },
  };
}
