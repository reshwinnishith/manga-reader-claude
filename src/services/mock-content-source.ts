import { MOCK_SERIES } from "@/data/mock-catalog";
import type { ContentSource } from "./content-source";

export const mockContentSource: ContentSource = {
  id: "mock",
  async listSeries() {
    return MOCK_SERIES;
  },
  async getSeries(id) {
    return MOCK_SERIES.find((s) => s.id === id) ?? null;
  },
};

/** The source used by the app. Swap/compose here when real sources arrive. */
export const contentSource: ContentSource = mockContentSource;
