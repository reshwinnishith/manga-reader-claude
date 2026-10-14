"use client";
import { useUserData } from "@/state/use-user-data";

export function PersistenceNotice() {
  const { warning } = useUserData();
  return warning ? <p className="notice" role="alert">{warning}</p> : null;
}
