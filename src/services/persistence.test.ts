import { expect, it } from "vitest";
import { createLocalStorageAdapter, STORAGE_KEY } from "./persistence";
import { createUserDataStore } from "@/state/user-data-store";
it.each(["{not json", JSON.stringify({ version: 99, library: { precious: true } })])("never overwrites unreadable existing data: %s", (raw) => {
  localStorage.setItem(STORAGE_KEY, raw);
  const store = createUserDataStore({ adapter: createLocalStorageAdapter() });
  store.getSnapshot();
  store.addToLibrary("test");
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
});
it("explains why writes are blocked when original data cannot be read", () => {
  localStorage.setItem(STORAGE_KEY, "{invalid");
  const store = createUserDataStore({ adapter: createLocalStorageAdapter() });
  store.getSnapshot();
  expect(store.getPersistenceWarning()).toContain("preserved");
});
it.each(["", " \r\n{invalid 日本語\t", JSON.stringify({ version: 99, library: { original: true } })])("retains the exact original text for recovery without changing it: %s", (raw) => {
  localStorage.setItem(STORAGE_KEY, raw);
  const store = createUserDataStore({ adapter: createLocalStorageAdapter() });
  store.getSnapshot();
  store.addToLibrary("session-only");
  expect(store.getPersistenceRecovery()?.originalText).toBe(raw);
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  expect(store.getPersistenceWarning()).toContain("not your original library");
});
