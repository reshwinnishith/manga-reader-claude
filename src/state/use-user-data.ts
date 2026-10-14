"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { UserData } from "@/domain/types";
import { getAppStore, type UserDataStore } from "./user-data-store";

export const UserDataStoreContext = createContext<UserDataStore | null>(null);

export function useStore(): UserDataStore {
  return useContext(UserDataStoreContext) ?? getAppStore();
}

/**
 * `data` is null until the client has loaded persisted data (always the case
 * during server render and hydration), so pages should render a loading state
 * for null. `actions` is the stable store itself.
 */
export function useUserData(): { data: UserData | null; actions: UserDataStore; warning?: string } {
  const store = useStore();
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { data, actions: store, warning: data ? store.getPersistenceWarning() : undefined };
}
