import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PersistenceNotice } from "./persistence-notice";
import { LibraryView } from "./library-view";
import { createLocalStorageAdapter, STORAGE_KEY } from "@/services/persistence";
import { createUserDataStore } from "@/state/user-data-store";
import { UserDataStoreContext } from "@/state/use-user-data";
import { CatalogProvider } from "@/state/catalog-context";
import { originalStorageBlob } from "@/lib/download";

function readBlob(blob: Blob, binary = false): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    if (binary) reader.readAsArrayBuffer(blob); else reader.readAsText(blob);
  });
}
function renderRecovery() {
  const store = createUserDataStore({ adapter: createLocalStorageAdapter() });
  render(<UserDataStoreContext.Provider value={store}><CatalogProvider series={[]}><PersistenceNotice /><LibraryView /></CatalogProvider></UserDataStoreContext.Provider>);
  return store;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("separates an unchanged original-data download from the new session JSON export", async () => {
  const raw = ' \r\n{ "version":99, "original library":"日本語 🐈" }\t';
  localStorage.setItem(STORAGE_KEY, raw);
  const blobs: Blob[] = [];
  const downloads: string[] = [];
  vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
  const store = renderRecovery();
  expect(screen.getByRole("alert")).toHaveTextContent("not your original library");
  expect(screen.queryByRole("button", { name: "Export backup" })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Download original stored data" }));
  const bytes = new Uint8Array(await readBlob(blobs[0]!, true) as ArrayBuffer);
  expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xfe]);
  let recovered = "";
  for (let i = 2; i < bytes.length; i += 2) recovered += String.fromCharCode(bytes[i]! | bytes[i + 1]! << 8);
  expect(recovered).toBe(raw);
  expect(downloads[0]).toBe("mangareader-original-storage.utf16le.txt");
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  await userEvent.setup().click(screen.getByRole("button", { name: "Export session data" }));
  const session = JSON.parse(await readBlob(blobs[1]!) as string);
  expect(session).toEqual(store.getSnapshot());
  expect(session.library).toEqual({});
  expect(downloads[1]).toBe("mangareader-session-data.json");
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
});

it("accurately reports denied browser access without offering an original-data download", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  renderRecovery();
  expect(screen.getByRole("alert")).toHaveTextContent("original record cannot be downloaded");
  expect(screen.queryByRole("button", { name: "Download original stored data" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export session data" })).toBeInTheDocument();
});

it("preserves every UTF-16 code unit, including lone surrogates and a leading BOM", async () => {
  const raw = "\ufeff\ud800\n\udc00\r\n";
  const bytes = new Uint8Array(await readBlob(originalStorageBlob(raw), true) as ArrayBuffer);
  expect(bytes.length).toBe(2 + raw.length * 2);
  for (let i = 0; i < raw.length; i++) expect(bytes[2 + i * 2]! | bytes[3 + i * 2]! << 8).toBe(raw.charCodeAt(i));
});
