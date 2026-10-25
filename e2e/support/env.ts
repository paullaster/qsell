import { e2eDatabaseUrl } from './database';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_SUFFIX, E2E_URL } from './constants';

/**
 * The environment the end-to-end server (and the seed) run with: the end-to-end database, its own
 * address, a known admin, and no outside services. Set explicitly so nothing from the developer's
 * `.env` (which Next would otherwise read) can reach a real database or service.
 */
export function e2eEnvironment(): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...inherited,
    DATABASE_URL: e2eDatabaseUrl(),
    APP_URL: E2E_URL,
    AUTH_URL: E2E_URL,
    NEXTAUTH_URL: E2E_URL,
    AUTH_TRUST_HOST: 'true',
    NEXT_DIST_DIR: `.next-e2e${E2E_SUFFIX}`,
    SUPER_ADMIN_EMAIL: E2E_ADMIN_EMAIL,
    SUPER_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
    SUPER_ADMIN_NAME: 'E2E Admin',
    SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_DSN: '',
    CLOUDINARY_URL: '',
    CLOUDINARY_CLOUD_NAME: '',
    CLOUDINARY_API_KEY: '',
    CLOUDINARY_API_SECRET: '',
    // Provider credentials are sealed with this key; a run that sets none gets a fixed one that guards nothing real.
    DATA_ENCRYPTION_KEY: inherited.DATA_ENCRYPTION_KEY ?? 'e2e-only-data-encryption-key-not-for-deployment',
    // The suite signs in far more often than any person would; the limiter itself is tested against the database.
    RATE_LIMIT_SCALE: '100',
    NEXT_TELEMETRY_DISABLED: '1',
    // Lets a test slow the finance actions with a cookie (see `injectedDelay`); off everywhere else.
    E2E_FAULTS: '1',
  };
}
