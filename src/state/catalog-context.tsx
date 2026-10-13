"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Series } from "@/domain/types";

interface CatalogValue {
  series: Series[];
  byId: Map<string, Series>;
}

const CatalogContext = createContext<CatalogValue | null>(null);

/**
 * Catalog metadata is loaded on the server (via the ContentSource) and handed
 * to client components here, so client pages never need to know where it came from.
 */
export function CatalogProvider({ series, children }: { series: Series[]; children: ReactNode }) {
  const value = useMemo(() => ({ series, byId: new Map(series.map((s) => [s.id, s])) }), [series]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return ctx;
}
