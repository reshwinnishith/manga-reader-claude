"use client";

import { useSyncExternalStore } from "react";

const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};

const snapshot = () => navigator.onLine;

export function AppStatus() {
  const online = useSyncExternalStore(subscribe, snapshot, () => true);
  return online ? null : (
    <p className="notice" role="status">
      You appear to be offline. Your library and saved progress remain on this device. Search and chapter images need an
      internet connection; offline manga reading is not available.
    </p>
  );
}
