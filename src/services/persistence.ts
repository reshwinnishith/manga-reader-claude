import type { UserData } from "@/domain/types";
import { migrateUserData } from "@/lib/user-data";

/**
 * Persistence boundary for user data. The app talks only to this interface, so
 * a Firestore-backed adapter (with merge-by-updatedAt sync) can replace or sit
 * alongside the local adapter without touching UI code.
 */
export interface PersistenceAdapter {
  load(): UserData | null;
  save(data: UserData): void;
  /** Optional: notify when another tab/device changed the data. */
  subscribe?(onExternalChange: () => void): () => void;
}

export const STORAGE_KEY = "manga-reader:v1";

export function createLocalStorageAdapter(key = STORAGE_KEY): PersistenceAdapter {
  return {
    load() {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        const migrated = migrateUserData(parsed);
        if (!migrated) return null; // unrecognised data: start fresh
        const from = (parsed as { version?: unknown }).version;
        if (from !== migrated.version) {
          // Keep the pre-migration copy once, then persist the upgraded shape.
          const backupKey = `${key}:backup-v${String(from)}`;
          if (window.localStorage.getItem(backupKey) === null) window.localStorage.setItem(backupKey, raw);
          window.localStorage.setItem(key, JSON.stringify(migrated));
        }
        return migrated;
      } catch {
        return null; // corrupt or unavailable storage: start fresh
      }
    },
    save(data) {
      try {
        window.localStorage.setItem(key, JSON.stringify(data));
      } catch {
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
