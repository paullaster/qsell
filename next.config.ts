import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';

const serverActionAllowedOrigins = (
  process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? 'omnicommerce.brainsporellc.com'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  experimental: {
    // Leave room for multipart metadata around the 2 MB logo-file limit.
    serverActions: {
      bodySizeLimit: '3mb',
      allowedOrigins: serverActionAllowedOrigins,
    },
  },
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

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
