import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MOCK_SERIES } from "@/data/mock-catalog";
import type { UserData } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import { createMemoryAdapter } from "@/services/persistence";
import { CatalogProvider } from "@/state/catalog-context";
import { UserDataStoreContext } from "@/state/use-user-data";
import { createUserDataStore } from "@/state/user-data-store";

export const FIXED_NOW = "2026-10-12T12:00:00.000Z";

export function makeStore(initial: UserData = emptyUserData()) {
  return createUserDataStore({
    adapter: createMemoryAdapter(initial),
    initial: () => initial,
    now: () => FIXED_NOW,
  });
}

/** Render with a fresh in-memory store and the mock catalog. */
export function renderWithApp(ui: ReactElement, initial?: UserData) {
  const store = makeStore(initial);
  const utils = render(
    <UserDataStoreContext.Provider value={store}>
      <CatalogProvider series={MOCK_SERIES}>{ui}</CatalogProvider>
    </UserDataStoreContext.Provider>,
  );
  return { store, ...utils };
}

export const getSeries = (id: string) => MOCK_SERIES.find((s) => s.id === id)!;
