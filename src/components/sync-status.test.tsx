import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import * as googleAccount from "@/services/google-account";
import { SyncStatusIndicator } from "./sync-status";
import { setCloudSyncEnabled } from "@/services/cloud-sync-preference";
import { publishSyncState } from "@/services/sync-status-bridge";
import { syncService } from "@/services/firestore-sync";
import * as firebaseConfig from "@/services/firebase-config";

describe("SyncStatusIndicator", () => {
  beforeEach(() => {
    window.localStorage.clear();
    publishSyncState({ status: "disabled", notice: undefined });
  });

  it("renders status text and accessible status container", () => {
    render(<SyncStatusIndicator />);
    const statusContainer = screen.getByRole("status");
    expect(statusContainer).toBeInTheDocument();
    expect(statusContainer).toHaveTextContent("Local storage");
  });

  it("can hide the action button if requested", () => {
    render(<SyncStatusIndicator showButton={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows 'Enable Cloud Sync' button when Firebase is configured and user has not opted in", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    setCloudSyncEnabled(false);

    render(<SyncStatusIndicator showButton={true} />);
    const enableBtn = screen.getByRole("button", { name: /enable cloud sync/i });
    expect(enableBtn).toBeInTheDocument();
  });

  it("enables cloud sync when 'Enable Cloud Sync' button is clicked", async () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    const syncSpy = vi.spyOn(syncService, "syncWithRemote").mockResolvedValue({
      version: 3,
      library: {},
      progress: {},
      readerModes: {},
      savedTitles: {},
      seeded: true,
    });

    render(<SyncStatusIndicator showButton={true} />);
    const enableBtn = screen.getByRole("button", { name: /enable cloud sync/i });

    await act(async () => {
      fireEvent.click(enableBtn);
    });

    expect(syncSpy).toHaveBeenCalled();
  });

  it("shows 'Retry sync' when in error state and opted in", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    setCloudSyncEnabled(true);
    publishSyncState({ status: "error" });

    render(<SyncStatusIndicator showButton={true} />);
    const retryBtn = screen.getByRole("button", { name: /retry cloud synchronization/i });
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveTextContent("Retry sync");
  });

  it("shows 'Cloud synced' and 'Sync now' button when successfully synced", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    setCloudSyncEnabled(true);
    publishSyncState({ status: "synced" });

    render(<SyncStatusIndicator showButton={true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Cloud synced");
    const syncBtn = screen.getByRole("button", { name: /synchronize library now/i });
    expect(syncBtn).toBeInTheDocument();
    expect(syncBtn).toHaveTextContent("Sync now");
  });

  it("shows the recovery or failure explanation in the status tooltip", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    setCloudSyncEnabled(true);
    publishSyncState({ status: "error", notice: "Cloud data could not be read safely. Nothing was changed." });
    render(<SyncStatusIndicator showButton={true} />);
    expect(screen.getByRole("status").parentElement).toHaveAttribute("title", expect.stringContaining("Nothing was changed"));
  });

  it("updates when the status changes and when the user opts in", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    render(<SyncStatusIndicator showButton={true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Local storage");
    act(() => setCloudSyncEnabled(true));
    act(() => publishSyncState({ status: "syncing" }));
    expect(screen.getByRole("status")).toHaveTextContent("Syncing");
    act(() => publishSyncState({ status: "synced" }));
    expect(screen.getByRole("status")).toHaveTextContent("Cloud synced");
  });

  describe("account and opt-out controls", () => {
    const configured = () => vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    const account = {
      linked: false,
      connect: vi.fn(),
    };
    beforeEach(() => {
      account.linked = false;
      account.connect = vi.fn();
      vi.spyOn(googleAccount, "connectGoogleAccount").mockImplementation((...args) => account.connect(...args));
      vi.spyOn(googleAccount, "watchGoogleLinked").mockImplementation((cb) => { cb(account.linked); return () => undefined; });
    });

    it("shows neither Google sign-in nor Disable unless Firebase is configured and the user opted in", () => {
      configured();
      setCloudSyncEnabled(false);
      const { unmount } = render(<SyncStatusIndicator />);
      expect(screen.queryByRole("button", { name: /sign in with google/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /disable cloud sync/i })).toBeNull();
      unmount();
      vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(false);
      setCloudSyncEnabled(true);
      render(<SyncStatusIndicator />);
      expect(screen.queryByRole("button", { name: /sign in with google/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /disable cloud sync/i })).toBeNull();
    });

    it("shows both once sync is enabled, and hides Google sign-in when Google is already linked", async () => {
      configured();
      setCloudSyncEnabled(true);
      publishSyncState({ status: "synced" });
      const { unmount } = render(<SyncStatusIndicator />);
      expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /disable cloud sync/i })).toBeInTheDocument();
      unmount();
      account.linked = true;
      render(<SyncStatusIndicator />);
      await act(async () => {});
      expect(screen.queryByRole("button", { name: /sign in with google/i })).toBeNull();
      expect(screen.getByRole("button", { name: /disable cloud sync/i })).toBeInTheDocument();
    });

    it("signs in through the safe flow and shows its message (success, cancellation and failure)", async () => {
      configured();
      setCloudSyncEnabled(true);
      publishSyncState({ status: "synced" });
      render(<SyncStatusIndicator />);
      for (const message of ["Google account linked.", "Sign-in cancelled. Nothing changed.", "Google sign-in failed."]) {
        account.connect.mockResolvedValueOnce({ status: "linked", message });
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: /sign in with google/i })); });
        expect(await screen.findByRole("alert")).toHaveTextContent(message);
      }
      expect(account.connect).toHaveBeenCalledTimes(3);
    });

    it("shows a message, and stays usable, if the sign-in flow throws unexpectedly", async () => {
      configured();
      setCloudSyncEnabled(true);
      publishSyncState({ status: "synced" });
      account.connect.mockRejectedValueOnce(new Error("boom"));
      render(<SyncStatusIndicator />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /sign in with google/i })); });
      expect(await screen.findByRole("alert")).toHaveTextContent(/unchanged/);
      expect(screen.getByRole("button", { name: /sign in with google/i })).not.toBeDisabled();
    });

    it("Disable cloud sync turns the opt-in off, keeps local data, and offers Enable again", async () => {
      configured();
      localStorage.setItem("manga-reader:v1", JSON.stringify({ version: 3, library: {}, progress: {}, readerModes: {}, savedTitles: {}, tombstones: {}, seeded: true }));
      const before = localStorage.getItem("manga-reader:v1");
      setCloudSyncEnabled(true);
      publishSyncState({ status: "synced" });
      render(<SyncStatusIndicator />);
      fireEvent.click(screen.getByRole("button", { name: /disable cloud sync/i }));
      expect(localStorage.getItem("manga-reader:v1:cloud-sync-enabled")).toBe("false");
      expect(localStorage.getItem("manga-reader:v1")).toBe(before);
      expect(screen.getByRole("status")).toHaveTextContent("Local storage");
      expect(screen.getByRole("alert")).toHaveTextContent(/kept/);
      expect(screen.getByRole("button", { name: /enable cloud sync/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /disable cloud sync/i })).toBeNull();
    });
  });
});
