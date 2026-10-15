"use client";

import { useEffect, useRef, useState } from "react";
import { isCloudSyncEnabled, setCloudSyncEnabled } from "@/services/cloud-sync-preference";
import { isFirebaseConfigured } from "@/services/firebase-config";
import { getSyncNotice, getSyncStatus, publishSyncState, subscribeSyncStatus, type SyncStatus } from "@/services/sync-status-bridge";
import { useUserData } from "@/state/use-user-data";
import { AlertIcon, CheckIcon, CloudIcon, RefreshIcon } from "./icons";

export function SyncStatusIndicator({ showButton = true }: { showButton?: boolean }) {
  const [status, setStatus] = useState<SyncStatus>(() => getSyncStatus());
  const [optedIn, setOptedIn] = useState<boolean>(() => isCloudSyncEnabled());
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const { data } = useUserData();
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);

  // Only while opted in: the SDK is already needed then, so watching the account costs nothing extra.
  useEffect(() => {
    if (!optedIn || !isFirebaseConfigured()) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import("@/services/google-account")
      .then(({ watchGoogleLinked }) => {
        if (!cancelled) unsubscribe = watchGoogleLinked(setGoogleLinked);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [optedIn]);

  useEffect(() => {
    return subscribeSyncStatus((newStatus) => {
      setStatus(newStatus);
      setOptedIn(isCloudSyncEnabled());
    });
  }, []);

  // The Firebase SDK is only downloaded when sync is actually used.
  const runSync = async () => {
    const { syncService } = await import("@/services/firestore-sync");
    await syncService.syncWithRemote(data!);
  };

  const handleManualSync = async () => {
    if (!data || isManualSyncing) return;
    setIsManualSyncing(true);
    try {
      await runSync();
    } finally {
      setIsManualSyncing(false);
    }
  };

  const handleEnableSync = async () => {
    if (!data || isManualSyncing) return;
    setCloudSyncEnabled(true);
    setOptedIn(true);
    setIsManualSyncing(true);
    try {
      await runSync();
    } finally {
      setIsManualSyncing(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!dataRef.current || signingIn) return;
    setSigningIn(true);
    setAccountMessage(null);
    try {
      const { connectGoogleAccount } = await import("@/services/google-account");
      const result = await connectGoogleAccount(() => dataRef.current!);
      setAccountMessage(result.message);
    } catch {
      setAccountMessage("Google sign-in could not start. Your library is unchanged.");
    } finally {
      setSigningIn(false);
    }
  };

  /** Stops listeners and every later cloud operation. Local data and the cloud copy are left as they are. */
  const handleDisableSync = () => {
    setCloudSyncEnabled(false);
    setOptedIn(false);
    setGoogleLinked(false);
    setAccountMessage("Cloud sync is off. Your library on this device and your cloud copy were kept.");
    publishSyncState({ notice: undefined });
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

  const config = getStatusConfig();
  const { label, color, icon } = config;
  const notice = getSyncNotice();
  const title = notice && (status === "error" || status === "synced") ? `${config.title}. ${notice}` : config.title;
  const canEnableCloud = isFirebaseConfigured() && !optedIn;

  return (
    <div
      className="sync-status"
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
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

      {showButton && canEnableCloud && (
        <button
          type="button"
          onClick={handleEnableSync}
          disabled={isManualSyncing}
          className="btn btn--secondary btn--compact"
          style={{
            padding: "2px 8px",
            fontSize: "0.75rem",
            marginLeft: "4px",
            minHeight: "26px",
          }}
          aria-label="Enable Cloud Sync"
        >
          {isManualSyncing ? "Enabling..." : "Enable Cloud Sync"}
        </button>
      )}

      {showButton && optedIn && status !== "disabled" && (
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
          aria-label={status === "error" ? "Retry cloud synchronization" : "Synchronize library now"}
        >
          {status === "syncing" || isManualSyncing
            ? "Syncing..."
            : status === "error"
            ? "Retry sync"
            : "Sync now"}
        </button>
      )}

      {showButton && optedIn && isFirebaseConfigured() && !googleLinked && (
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={signingIn}
          className="btn btn--secondary btn--compact"
          style={{ padding: "2px 8px", fontSize: "0.75rem", marginLeft: "4px", minHeight: "26px" }}
          aria-label="Sign in with Google"
        >
          {signingIn ? "Signing in..." : "Sign in with Google"}
        </button>
      )}

      {showButton && optedIn && isFirebaseConfigured() && (
        <button
          type="button"
          onClick={handleDisableSync}
          className="btn btn--secondary btn--compact"
          style={{ padding: "2px 8px", fontSize: "0.75rem", marginLeft: "4px", minHeight: "26px" }}
          aria-label="Disable cloud sync"
        >
          Disable cloud sync
        </button>
      )}

      {accountMessage && (
        <span role="alert" style={{ flexBasis: "100%", fontSize: "0.75rem" }}>
          {accountMessage}
        </span>
      )}
    </div>
  );
}
