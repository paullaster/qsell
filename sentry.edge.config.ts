import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

// The Edge runtime has no native add-ons, so profiling is configured only in
// sentry.server.config.ts.
Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.DEPLOYMENT_VERSION,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  integrations: [
    // Sentry Logs. error/warn only: this app logs expected conditions at info.
    Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] }),
  ],
});
