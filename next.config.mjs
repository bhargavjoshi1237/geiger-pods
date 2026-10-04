/** @type {import('next').NextConfig} */
const basePath = process.env.GEIGER_BASE_PATH ?? (process.env.NODE_ENV === "production" ? "/pods" : "");

const nextConfig = {
  distDir: process.env.GEIGER_DIST_DIR || ".next",
  transpilePackages: ["@geiger/ui"],
  basePath,
  allowedDevOrigins: ["127.0.0.1"],
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
