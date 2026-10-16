import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchError, normalizeMedia, type AniListClient, type BrowseOptions, type BrowseResult } from "@/services/anilist";
import { FIXTURE_MEDIA, FIXTURE_MANHWA } from "@/test/anilist-fixtures";
import { useBrowseSection } from "./use-browse-section";

const NOW = "2026-10-14T00:00:00.000Z";
const moon = normalizeMedia(FIXTURE_MEDIA, NOW)!;
const tap = normalizeMedia(FIXTURE_MANHWA, NOW)!;

function browseResult(items = [moon, tap], hasNextPage = false, page = 1): BrowseResult {
  return { items, hasNextPage, page };
}

function makeClient(impl: (opts: BrowseOptions) => Promise<BrowseResult> = async () => browseResult()) {
  const browse = vi.fn(impl);
  const search = vi.fn<AniListClient["search"]>();
  return { client: { search, browse } as AniListClient, browse };
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe("useBrowseSection", () => {
  it("starts loading and transitions to success with items", async () => {
    const { client, browse } = makeClient();
    const { result } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all"));
    expect(result.current.view.status).toBe("loading");
    await act(async () => {});
    expect(result.current.view.status).toBe("success");
    if (result.current.view.status === "success") {
      expect(result.current.view.items).toHaveLength(2);
      expect(result.current.view.items[0]!.id).toBe("al-101");
    }
    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse.mock.calls[0]![0]).toMatchObject({ sort: "TRENDING_DESC", country: "all", page: 1 });
  });

  it("passes the country to the browse call", async () => {
    const { client, browse } = makeClient();
    renderHook(() => useBrowseSection(client, "POPULARITY_DESC", "JP"));
    await act(async () => {});
    expect(browse.mock.calls[0]![0]).toMatchObject({ sort: "POPULARITY_DESC", country: "JP" });
  });

  it("respects the limit and trims the result set", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...moon, id: `al-${i + 1}` }));
    const { client } = makeClient(async () => browseResult(many));
    const { result } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all", 5));
    await act(async () => {});
    if (result.current.view.status === "success") {
      expect(result.current.view.items).toHaveLength(5);
    }
  });

  it("enters error state on network failure", async () => {
    const { client } = makeClient(async () => { throw new SearchError("offline", "No connection"); });
    const { result } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all"));
    await act(async () => {});
    expect(result.current.view.status).toBe("error");
    if (result.current.view.status === "error") {
      expect(result.current.view.error.kind).toBe("offline");
    }
  });

  it("retries on demand and clears the error", async () => {
    let calls = 0;
    const { client, browse } = makeClient(async () => {
      if (++calls === 1) throw new SearchError("server", "Server error");
      return browseResult();
    });
    const { result } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all"));
    await act(async () => {});
    expect(result.current.view.status).toBe("error");
    act(() => { result.current.retry(); });
    expect(result.current.view.status).toBe("loading");
    await act(async () => {});
    expect(result.current.view.status).toBe("success");
    expect(browse).toHaveBeenCalledTimes(2);
  });

  it("shows empty success when API returns no items", async () => {
    const { client } = makeClient(async () => browseResult([]));
    const { result } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all"));
    await act(async () => {});
    expect(result.current.view.status).toBe("success");
    if (result.current.view.status === "success") {
      expect(result.current.view.items).toHaveLength(0);
    }
  });

  it("re-fetches when sort changes", async () => {
    const { client, browse } = makeClient();
    const { rerender } = renderHook(
      ({ sort }: { sort: "TRENDING_DESC" | "POPULARITY_DESC" }) => useBrowseSection(client, sort, "all"),
      { initialProps: { sort: "TRENDING_DESC" } as { sort: "TRENDING_DESC" | "POPULARITY_DESC" } },
    );
    await act(async () => {});
    rerender({ sort: "POPULARITY_DESC" });
    await act(async () => {});
    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse.mock.calls[1]![0]).toMatchObject({ sort: "POPULARITY_DESC" });
  });

  it("re-fetches when country changes", async () => {
    const { client, browse } = makeClient();
    const { rerender } = renderHook(
      ({ country }: { country: "all" | "JP" }) => useBrowseSection(client, "TRENDING_DESC", country),
      { initialProps: { country: "all" } as { country: "all" | "JP" } },
    );
    await act(async () => {});
    rerender({ country: "JP" });
    await act(async () => {});
    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse.mock.calls[1]![0]).toMatchObject({ country: "JP" });
  });

  it("ignores a resolved response after unmount (no state update)", async () => {
    let resolve!: (r: BrowseResult) => void;
    const { client } = makeClient(() => new Promise<BrowseResult>((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useBrowseSection(client, "TRENDING_DESC", "all"));
    // Still loading — unmount before the promise resolves
    unmount();
    // Resolving after unmount should not cause an act warning or state update
    await act(async () => { resolve(browseResult()); });
    // The status should still be "loading" (component is gone)
    expect(result.current.view.status).toBe("loading");
  });
});
