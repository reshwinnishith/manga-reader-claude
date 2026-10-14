import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { contentSource } from "@/services/mock-content-source";
import { CatalogProvider } from "@/state/catalog-context";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Manga Reader", template: "%s · Manga Reader" },
  description: "A simple, beautiful manga and manhwa reader.",
  applicationName: "Manga Reader",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Manga Reader", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0b10",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const series = await contentSource.listSeries();
  return (
    <html lang="en">
      <body>
        <CatalogProvider series={series}>{children}</CatalogProvider>
      </body>
    </html>
  );
}
