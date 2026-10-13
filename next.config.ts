import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Dev only: let a phone/tablet on the same Wi-Fi load the dev server by LAN IP
  // or Bonjour name (e.g. http://192.168.1.20:3000, http://my-mac.local:3000).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
};

export default nextConfig;
