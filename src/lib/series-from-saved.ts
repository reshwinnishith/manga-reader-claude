import type { SavedTitle, Series } from "@/domain/types";
import { hashString } from "./placeholder";

/** View a saved search result as a `Series` (no chapters: those arrive in a later checkpoint). */
export function seriesFromSaved(saved: SavedTitle): Series {
  return {
    id: saved.id,
    title: saved.title,
    type: saved.type,
    author: saved.authors.join(", ") || "Unknown author",
    year: saved.year ?? 0,
    status: saved.status,
    genres: saved.genres,
    description: saved.description || "No description available.",
    hue: hashString(saved.id) % 360,
    chapters: [],
    source: saved.source,
    coverUrl: saved.coverUrl,
    externalUrl: saved.url,
    reportedChapters: saved.reportedChapters,
  };
}
