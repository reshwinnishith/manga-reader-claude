"use client";

import { useUserData } from "@/state/use-user-data";
import { CheckIcon, PlusIcon } from "./icons";

/** Add/remove toggle. Compact variant is for cards in lists. */
export function AddToLibraryButton({
  seriesId,
  title,
  compact = false,
}: {
  seriesId: string;
  title: string;
  compact?: boolean;
}) {
  const { data, actions } = useUserData();
  const inLibrary = !!data?.library[seriesId];
  const disabled = data === null;

  return (
    <button
      type="button"
      className={`btn ${inLibrary ? "btn--secondary" : "btn--accent"} ${compact ? "btn--compact" : ""}`}
      disabled={disabled}
      aria-pressed={inLibrary}
      aria-label={inLibrary ? `Remove ${title} from library` : `Add ${title} to library`}
      onClick={() => (inLibrary ? actions.removeFromLibrary(seriesId) : actions.addToLibrary(seriesId))}
    >
      {inLibrary ? <CheckIcon width={18} height={18} /> : <PlusIcon width={18} height={18} />}
      <span>{inLibrary ? "In Library" : "Add"}</span>
    </button>
  );
}
