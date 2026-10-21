/** The port the end-to-end server listens on, kept apart from the development server's 3000. */
export const E2E_PORT = 3100;
export const E2E_URL = `http://localhost:${String(E2E_PORT)}`;

/** The admin the seed creates. The password has no `#`: Next's dotenv would cut it short. */
export const E2E_ADMIN_EMAIL = 'e2e-admin@example.test';
export const E2E_ADMIN_PASSWORD = 'E2eTest-Passw0rd-9';

/** Where the signed-in browser state is kept between tests. */
export const AUTH_FILE = 'e2e/.auth/admin.json';

/** The port the statement-pull test's stand-in for Jenga listens on (see e2e/statement-pull.spec.ts and the seed). */
export const FAKE_BANK_PORT = 3199;
