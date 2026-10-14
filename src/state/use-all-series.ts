"use client";

import { useMemo } from "react";
import type { Series } from "@/domain/types";
import { seriesFromSaved } from "@/lib/series-from-saved";
import { useCatalog } from "./catalog-context";
import { useUserData } from "./use-user-data";

/** Demo catalog plus any titles the user saved from search. */
export function useAllSeries(): Series[] {
  const { series } = useCatalog();
  const { data } = useUserData();
  const saved = data?.savedTitles;
  return useMemo(
    () => (saved && Object.keys(saved).length ? [...series, ...Object.values(saved).map(seriesFromSaved)] : series),
    [series, saved],
  );
}
