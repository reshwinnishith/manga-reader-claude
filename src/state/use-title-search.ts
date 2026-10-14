"use client";

import { useCallback, useEffect, useState } from "react";
import type { SavedTitle } from "@/domain/types";
import {
  MIN_QUERY_LENGTH,
  SearchError,
  type AniListClient,
  type CountryFilter,
} from "@/services/anilist";

export const SEARCH_DEBOUNCE_MS = 450;

interface Slot {
  key: string;
  items: SavedTitle[];
  hasNextPage: boolean;
  page: number;
  error?: SearchError;
  loadingMore: boolean;
  moreError?: SearchError;
}

export type TitleSearchView =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: SearchError }
  | { status: "success"; items: SavedTitle[]; hasNextPage: boolean; loadingMore: boolean; moreError?: SearchError };

const toSearchError = (err: unknown) =>
  err instanceof SearchError ? err : new SearchError("bad-response", "Something went wrong while searching.");

/**
 * Debounced, cancellable title search. Typing shows the loading state at once;
 * the request itself waits until typing pauses and supersedes any in-flight one,
 * so a burst of keystrokes costs a single API call.
 */
export function useTitleSearch(client: AniListClient, query: string, country: CountryFilter) {
  const trimmed = query.trim();
  const active = trimmed.length >= MIN_QUERY_LENGTH;
  const key = `${country}|${trimmed.toLowerCase()}`;
  const [slot, setSlot] = useState<Slot | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await client.search({ query: trimmed, country, page: 1, signal: controller.signal });
        if (controller.signal.aborted) return; // a newer search has taken over
        setSlot({ key, items: r.items, hasNextPage: r.hasNextPage, page: 1, loadingMore: false });
      } catch (err) {
        const error = toSearchError(err);
        if (error.kind === "aborted" || controller.signal.aborted) return;
        setSlot({ key, items: [], hasNextPage: false, page: 1, error, loadingMore: false });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, trimmed, country, key, client, attempt]);

  const current = slot && slot.key === key ? slot : null;

  const loadMore = useCallback(async () => {
    if (!current || current.loadingMore || !current.hasNextPage) return;
    const next = current.page + 1;
    setSlot({ ...current, loadingMore: true, moreError: undefined });
    try {
      const r = await client.search({ query: trimmed, country, page: next });
      setSlot((prev) => {
        if (!prev || prev.key !== key) return prev;
        const known = new Set(prev.items.map((i) => i.id));
        return {
          ...prev,
          items: [...prev.items, ...r.items.filter((i) => !known.has(i.id))],
          hasNextPage: r.hasNextPage,
          page: next,
          loadingMore: false,
        };
      });
    } catch (err) {
      setSlot((prev) => (prev && prev.key === key ? { ...prev, loadingMore: false, moreError: toSearchError(err) } : prev));
    }
  }, [client, country, current, key, trimmed]);

  const retry = useCallback(() => {
    setSlot(null);
    setAttempt((n) => n + 1);
  }, []);

  let view: TitleSearchView;
  if (!active) view = { status: "idle" };
  else if (!current) view = { status: "loading" };
  else if (current.error) view = { status: "error", error: current.error };
  else
    view = {
      status: "success",
      items: current.items,
      hasNextPage: current.hasNextPage,
      loadingMore: current.loadingMore,
      moreError: current.moreError,
    };
  return { view, retry, loadMore };
}
