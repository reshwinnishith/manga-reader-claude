"use client";
import { useUserData } from "@/state/use-user-data";
import { downloadBlob, originalStorageBlob } from "@/lib/download";

export function PersistenceNotice() {
  const { warning, recovery } = useUserData();
  if (!warning) return null;
  const original = recovery?.originalText;
  return <section className="notice" aria-label="Storage recovery">
    <p role="alert">{warning}</p>
    {original !== undefined && <>
      <button className="btn btn--secondary" type="button" onClick={() => downloadBlob(originalStorageBlob(original), "mangareader-original-storage.utf16le.txt")}>Download original stored data</button>
      <p>This recovery file preserves the original stored text without parsing or reformatting (UTF-16LE). Downloading does not change browser storage. It is separate from the session JSON export in Library.</p>
    </>}
  </section>;
}
