import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
});
