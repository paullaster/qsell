import * as Sentry from '@sentry/nextjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.DEPLOYMENT_VERSION,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // Attaches local variable values to server stack frames.
  includeLocalVariables: true,
  profileSessionSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  profileLifecycle: 'trace',
  integrations: [
    nodeProfilingIntegration(),
    // Sentry Logs. error/warn only: this app logs expected conditions at info.
    Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] }),
  ],
});
