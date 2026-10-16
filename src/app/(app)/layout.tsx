import type { ReactNode } from "react";
import { AppStatus } from "@/components/app-status";
import { PersistenceNotice } from "@/components/persistence-notice";
import { AppNav } from "@/components/app-nav";

/** Browsing shell: bottom tab bar on phones, side rail on larger screens. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <AppNav />
      <main id="main" className="shell__main">
        <AppStatus />
        <PersistenceNotice />
        {children}
      </main>
    </div>
  );
}
