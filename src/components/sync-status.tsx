"use client";

import { useEffect, useState } from "react";
import { syncService, type SyncStatus } from "@/services/firestore-sync";
import { useUserData } from "@/state/use-user-data";
import { AlertIcon, CheckIcon, CloudIcon, RefreshIcon } from "./icons";

export function SyncStatusIndicator({ showButton = true }: { showButton?: boolean }) {
  const [status, setStatus] = useState<SyncStatus>(() => syncService.getStatus());
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const { data } = useUserData();

  useEffect(() => {
    return syncService.subscribeStatus((newStatus) => {
      setStatus(newStatus);
    });
  }, []);

  const handleManualSync = async () => {
    if (!data || isManualSyncing) return;
    setIsManualSyncing(true);
    try {
      await syncService.syncWithRemote(data);
    } finally {
      setIsManualSyncing(false);
    }
  };

  const getStatusConfig = () => {
    switch (status) {
      case "syncing":
        return {
          label: "Syncing...",
          color: "var(--accent, #6366f1)",
          icon: <RefreshIcon className="spin" width={14} height={14} />,
          title: "Uploading and downloading latest changes",
        };
      case "synced":
        return {
          label: "Cloud synced",
          color: "#10b981",
          icon: <CheckIcon width={14} height={14} />,
          title: "Your library and progress are backed up to the cloud",
        };
      case "offline":
        return {
          label: "Offline (saved locally)",
          color: "#9ca3af",
          icon: <CloudIcon width={14} height={14} />,
          title: "Working offline. Changes will sync when reconnected",
        };
      case "error":
        return {
          label: "Sync error (saved locally)",
          color: "#f59e0b",
          icon: <AlertIcon width={14} height={14} />,
          title: "Cloud sync failed. Data is safely saved in your browser",
        };
      case "disabled":
      default:
        return {
          label: "Local storage",
          color: "#9ca3af",
          icon: <CloudIcon width={14} height={14} />,
          title: "Data is stored locally in your browser",
        };
    }
  };

  const { label, color, icon, title } = getStatusConfig();

  return (
    <div
      className="sync-status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "0.8125rem",
        color: "var(--text-secondary, #9995a7)",
      }}
      title={title}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          color,
          fontWeight: 500,
        }}
        role="status"
        aria-live="polite"
      >
        {icon}
        <span>{label}</span>
      </span>

      {showButton && status !== "disabled" && (
        <button
          type="button"
          onClick={handleManualSync}
          disabled={status === "syncing" || isManualSyncing || status === "offline"}
          className="btn btn--secondary btn--compact"
          style={{
            padding: "2px 8px",
            fontSize: "0.75rem",
            marginLeft: "4px",
            minHeight: "26px",
          }}
          aria-label="Synchronize library now"
        >
          {status === "syncing" || isManualSyncing ? "Syncing..." : "Sync now"}
        </button>
      )}
    </div>
  );
}
