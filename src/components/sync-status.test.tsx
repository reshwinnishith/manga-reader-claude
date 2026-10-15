import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SyncStatusIndicator } from "./sync-status";
import { syncService, setCloudSyncEnabled } from "@/services/firestore-sync";
import * as firebaseConfig from "@/services/firebase";

describe("SyncStatusIndicator", () => {
  beforeEach(() => {
    window.localStorage.clear();
    syncService.setStatus("disabled");
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
    syncService.setStatus("error");

    render(<SyncStatusIndicator showButton={true} />);
    const retryBtn = screen.getByRole("button", { name: /retry cloud synchronization/i });
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveTextContent("Retry sync");
  });

  it("shows 'Cloud synced' and 'Sync now' button when successfully synced", () => {
    vi.spyOn(firebaseConfig, "isFirebaseConfigured").mockReturnValue(true);
    setCloudSyncEnabled(true);
    syncService.setStatus("synced");

    render(<SyncStatusIndicator showButton={true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Cloud synced");
    const syncBtn = screen.getByRole("button", { name: /synchronize library now/i });
    expect(syncBtn).toBeInTheDocument();
    expect(syncBtn).toHaveTextContent("Sync now");
  });
});
