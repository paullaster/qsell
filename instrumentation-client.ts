import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  // Client events must match the server release to share source maps and traces.
  release: process.env.NEXT_PUBLIC_DEPLOYMENT_VERSION,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // Browser profiling attaches to sampled spans; requires the js-profiling header
  // from next.config.ts and is a no-op outside Chromium.
  profileSessionSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  profileLifecycle: 'trace',
  // Replay defaults already mask all text and inputs and block media. Low-traffic
  // storefront, so a quarter of sessions; every session that errors is captured.
  replaysSessionSampleRate: 0.25,
  replaysOnErrorSampleRate: 1.0,
  integrations: [
    // Order matters: browserTracing must precede browserProfiling.
    Sentry.browserTracingIntegration(),
    Sentry.browserProfilingIntegration(),
    Sentry.replayIntegration({
      networkDetailDenyUrls: [/\/api\/auth/, /\/api\/payments/, /\/api\/admin/],
    }),
    // Sentry Logs. error/warn only: this app logs expected conditions at info.
    Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] }),
  ],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
