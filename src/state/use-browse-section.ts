"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SavedTitle } from "@/domain/types";
import {
  SearchError,
  type AniListClient,
  type BrowseOptions,
  type BrowseSort,
  type CountryFilter,
} from "@/services/anilist";

export type { BrowseSort };

export type BrowseSectionView =
  | { status: "loading" }
  | { status: "error"; error: SearchError }
  | { status: "success"; items: SavedTitle[] };

interface Slot {
  key: string;
  items?: SavedTitle[];
  error?: SearchError;
}

const toSearchError = (err: unknown) =>
  err instanceof SearchError ? err : new SearchError("bad-response", "Something went wrong.");

/**
 * Fetches a single browse section (trending or popular) from AniList on mount.
 * Re-fetches when sort or country changes. Aborts cleanly on unmount.
 * Distinct from useTitleSearch: no query, no debounce, no pagination.
 */
export function useBrowseSection(
  client: AniListClient,
  sort: BrowseSort,
  country: CountryFilter,
  /** Maximum number of items to keep from the response (default: 8). */
  limit = 8,
): { view: BrowseSectionView; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${sort}|${country}|${limit}|${attempt}`;
  const [slot, setSlot] = useState<Slot | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const options: BrowseOptions = { sort, country, page: 1, signal: controller.signal };

    client.browse(options).then(
      (result) => {
        if (controller.signal.aborted) return;
        setSlot({ key, items: result.items.slice(0, limit) });
      },
      (err: unknown) => {
        const error = toSearchError(err);
        if (error.kind === "aborted" || controller.signal.aborted) return;
        setSlot({ key, error });
      },
    );

    return () => { controller.abort(); };
  }, [client, sort, country, limit, key]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const view: BrowseSectionView = useMemo(() => {
    if (!slot || slot.key !== key) return { status: "loading" };
    if (slot.error) return { status: "error", error: slot.error };
    return { status: "success", items: slot.items ?? [] };
  }, [slot, key]);

  return { view, retry };
}
