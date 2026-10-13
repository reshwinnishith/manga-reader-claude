import type { Series } from "@/domain/types";

/**
 * Abstraction over where series metadata comes from. Checkpoint 1 only has the
 * mock implementation. Later, each permitted source (and the verified
 * series/chapter equivalence layer) implements this same interface and a
 * composite source merges them.
 */
export interface ContentSource {
  readonly id: string;
  listSeries(): Promise<Series[]>;
  getSeries(id: string): Promise<Series | null>;
}
