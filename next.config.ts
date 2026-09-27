import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
