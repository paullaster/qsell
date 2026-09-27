import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dev server defaults to localhost, but phones on the same LAN open the
  // app by the laptop's private IP. Allow the current LAN origin for dev HMR
  // so the page hydrates and React touch/click handlers attach on mobile.
  ...(process.env.NODE_ENV === 'development'
    ? {
        allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? '192.168.100.154')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      }
    : {}),
  // Produces a minimal, self-contained server in .next/standalone for Docker.
  output: 'standalone',
  // Keeps client/server assets aligned when deployments are rolled forward.
  deploymentId: process.env.DEPLOYMENT_VERSION,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
};

export default nextConfig;
