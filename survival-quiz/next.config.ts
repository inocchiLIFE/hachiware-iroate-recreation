import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["firebase-admin"],
  poweredByHeader: false,
};

export default nextConfig;
