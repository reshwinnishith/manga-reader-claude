import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";

/** Browsing shell: bottom tab bar on phones, side rail on larger screens. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <AppNav />
      <main id="main" className="shell__main">
        <div aria-label="App version" title={`Build ${revision}`} style={{ padding: "8px 0 12px", color: "#9995a7", fontSize: 12 }}>
          Manga Reader · v1.01
        </div>
        {children}
      </main>
    </div>
  );
}
