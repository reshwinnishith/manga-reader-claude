import { ImageResponse } from "next/og";

/**
 * App icons rendered at build time (no binary assets in the repo).
 * /icons/icon-192.png, /icons/icon-512.png, /icons/maskable-512.png,
 * /icons/apple-touch-icon.png
 */
const ICONS = {
  "icon-192.png": { size: 192, safe: 1 },
  "icon-512.png": { size: 512, safe: 1 },
  "maskable-512.png": { size: 512, safe: 0.72 }, // keep art inside the maskable safe zone
  "apple-touch-icon.png": { size: 180, safe: 1 },
} as const;

export function generateStaticParams() {
  return Object.keys(ICONS).map((name) => ({ name }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const spec = ICONS[name as keyof typeof ICONS];
  if (!spec) return new Response("Not found", { status: 404 });

  const { size, safe } = spec;
  const book = size * 0.5 * safe;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #7c5cff 0%, #2b1b6b 100%)",
        }}
      >
        <div
          style={{
            width: book,
            height: book * 1.3,
            display: "flex",
            borderRadius: book * 0.1,
            background: "rgba(255,255,255,0.95)",
            boxShadow: `${-book * 0.12}px 0 0 rgba(255,255,255,0.45)`,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: book * 0.46, height: book * 0.46, borderRadius: 9999, background: "#4b2fd0" }} />
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
