import type { UserData } from "@/domain/types";
import { migrateUserData } from "@/lib/user-data";

/**
 * Persistence boundary for user data. The app talks only to this interface, so
 * a Firestore-backed adapter (with merge-by-updatedAt sync) can replace or sit
 * alongside the local adapter without touching UI code.
 */
/** localStorage exposes text, not the browser's underlying on-disk encoding. */
export interface StorageRecovery { originalText?: string }

export interface PersistenceAdapter {
  load(): UserData | null;
  getWarning?(): string | undefined;
  getRecovery?(): StorageRecovery | undefined;
  save(data: UserData): void;
  /** Optional: notify when another tab/device changed the data. */
  subscribe?(onExternalChange: () => void): () => void;
}

export const STORAGE_KEY = "manga-reader:v1";

export function createLocalStorageAdapter(key = STORAGE_KEY): PersistenceAdapter {
  let canWrite = true;
  let warning: string | undefined;
  let recovery: StorageRecovery | undefined;
  const unreadable = (originalText?: string) => {
    canWrite = false;
    recovery ??= { originalText };
    warning = recovery.originalText !== undefined
      ? "The original stored record could not be loaded and has been preserved unchanged. Download original stored data for recovery. Session export contains only this session's data, not your original library. Changes in this session cannot be saved."
      : "Browser storage could not be read. The original record cannot be downloaded in this session. Session export contains only this session's data, not your original library. Changes in this session cannot be saved.";
  };
  return {
    getWarning: () => warning,
    getRecovery: () => recovery,
    load() {
      let raw: string | undefined;
      try {
        const stored = window.localStorage.getItem(key);
        if (stored === null) return null;
        raw = stored;
        const parsed: unknown = JSON.parse(raw);
        const migrated = migrateUserData(parsed);
        if (!migrated) { unreadable(raw); return null; } // preserve unreadable/future-version data
        const from = (parsed as { version?: unknown }).version;
        if (from !== migrated.version) {
          // Keep the pre-migration copy once, then persist the upgraded shape.
          const backupKey = `${key}:backup-v${String(from)}`;
          if (window.localStorage.getItem(backupKey) === null) window.localStorage.setItem(backupKey, raw);
          window.localStorage.setItem(key, JSON.stringify(migrated));
        }
        return migrated;
      } catch {
        unreadable(raw);
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
