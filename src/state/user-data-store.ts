import { emptyUserData } from "@/lib/user-data";
import type { ReaderMode, ReadingStatus, SavedTitle, Series, UserData } from "@/domain/types";
import type { PersistenceAdapter, StorageRecovery } from "@/services/persistence";
import { createAppPersistenceAdapter } from "@/services/persistence-factory";
import * as ops from "@/lib/user-data";

export interface UserDataStore {
  /** Current data, or null on the server / before first client load. */
  getSnapshot(): UserData | null;
  getPersistenceWarning(): string | undefined;
  getPersistenceRecovery(): StorageRecovery | undefined;
  getServerSnapshot(): null;
  subscribe(listener: () => void): () => void;
  addToLibrary(seriesId: string, status?: ReadingStatus): void;
  /** Save a search result (metadata snapshot) and add it to the library. */
  saveExternalTitle(title: SavedTitle): void;
  removeFromLibrary(seriesId: string): void;
  replaceData(data: UserData): void;
  setReadingStatus(seriesId: string, status: ReadingStatus): void;
  setReaderMode(seriesId: string, mode: ReaderMode): void;
  recordProgress(series: Series, chapterId: string, page: number, atEnd?: boolean): void;
}

interface StoreOptions {
  adapter: PersistenceAdapter;
  /** Used when the adapter has nothing stored. Defaults to the demo library. */
  initial?: () => UserData;
  now?: () => string;
}

/**
 * A tiny external store (compatible with useSyncExternalStore) that owns the
 * in-memory copy of user data and writes every change through the adapter.
 * Keeping this separate from React makes it trivially testable and lets a
 * remote-synced adapter slot in later.
 */
export function createUserDataStore({
  adapter,
  initial = emptyUserData,
  now = () => new Date().toISOString(),
}: StoreOptions): UserDataStore {
  let state: UserData | null = null;
  const listeners = new Set<() => void>();
  let unsubscribeExternal: (() => void) | undefined;

  const load = () => {
    const stored = adapter.load();
    if (stored) return stored;
    const seeded = initial();
    adapter.save(seeded);
    return seeded;
  };

  const emit = () => listeners.forEach((l) => l());

  const update = (fn: (d: UserData) => UserData) => {
    const current = state ?? load();
    const next = fn(current);
    if (next === current) return;
    state = next;
    adapter.save(next);
    emit();
  };

  return {
    getPersistenceWarning: () => adapter.getWarning?.(),
    getPersistenceRecovery: () => adapter.getRecovery?.(),
    getSnapshot() {
      if (typeof window === "undefined") return null;
      if (state === null) state = load();
      return state;
    },
    getServerSnapshot: () => null,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && adapter.subscribe) {
        unsubscribeExternal = adapter.subscribe(() => {
          state = load();
          emit();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeExternal?.();
          unsubscribeExternal = undefined;
        }
      };
    },
    addToLibrary: (id, status) => update((d) => ops.addToLibrary(d, id, now(), status)),
    saveExternalTitle: (title) => update((d) => ops.saveExternalTitle(d, title, now())),
    removeFromLibrary: (id) => update((d) => ops.removeFromLibrary(d, id, now())),
    replaceData: (data) => update(() => data),
    setReadingStatus: (id, status) => update((d) => ops.setReadingStatus(d, id, status, now())),
    setReaderMode: (id, mode) => update((d) => ops.setReaderMode(d, id, mode, now())),
    recordProgress: (series, chapterId, page, atEnd = false) =>
      update((d) => ops.recordProgress(d, series, chapterId, page, now(), atEnd)),
  };
}

let appStore: UserDataStore | undefined;

/** Lazily created singleton for the running app (client only). */
export function getAppStore(): UserDataStore {
  appStore ??= createUserDataStore({ adapter: createAppPersistenceAdapter() });
  return appStore;
}
