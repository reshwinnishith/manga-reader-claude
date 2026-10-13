import type { UserData } from "@/domain/types";

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

function isUserData(value: unknown): value is UserData {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<UserData>;
  return (
    v.version === 1 &&
    !!v.library && typeof v.library === "object" &&
    !!v.progress && typeof v.progress === "object" &&
    !!v.readerModes && typeof v.readerModes === "object"
  );
}

export function createLocalStorageAdapter(key = STORAGE_KEY): PersistenceAdapter {
  return {
    load() {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isUserData(parsed) ? parsed : null;
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
