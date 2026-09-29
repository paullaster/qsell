import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  // Client events must match the server release to share source maps and traces.
  release: process.env.NEXT_PUBLIC_DEPLOYMENT_VERSION,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
