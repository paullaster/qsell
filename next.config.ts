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
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: 'brainspore-llc',

  project: 'omnicommerce-instance',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: '/monitoring',

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
