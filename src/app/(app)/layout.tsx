import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";

/** Browsing shell: bottom tab bar on phones, side rail on larger screens. */
export default function AppLayout({ children }: { children: ReactNode }) {
  // Vercel supplies this at build time. Display the actual deployed revision,
  // rather than a manually maintained label that can become inaccurate.
  const revision = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <AppNav />
      <main id="main" className="shell__main">
        {children}
        <footer aria-label="App version" style={{ padding: "32px 0 16px", textAlign: "center", color: "#9995a7", fontSize: 12 }}>
          Manga Reader · Checkpoint 2B · Build {revision}
        </footer>
      </main>
    </div>
  );
}
