/** The port the end-to-end server listens on, kept apart from the development server's 3000. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
/** A run on another port (E2E_PORT) keeps its own build folder and sign-in file, so it cannot disturb a run on 3100. */
export const E2E_SUFFIX = E2E_PORT === 3100 ? '' : `-${String(E2E_PORT)}`;
export const E2E_URL = `http://localhost:${String(E2E_PORT)}`;

/** The admin the seed creates. The password has no `#`: Next's dotenv would cut it short. */
export const E2E_ADMIN_EMAIL = 'e2e-admin@example.test';
export const E2E_ADMIN_PASSWORD = 'E2eTest-Passw0rd-9';

/** The vendor portal logins the seed creates, one per browser project. */
export const E2E_VENDOR_PASSWORD = 'E2eVendor-Passw0rd-7';
export const e2eVendorEmail = (project: string): string => `e2e-vendor-${project}@example.test`;

/** The shopper logins the storefront tests create (see shopper-fixture.ts). */
export const E2E_SHOPPER_PASSWORD = 'E2eShopper-Passw0rd-5';

/** Where the signed-in browser state is kept between tests. */
export const AUTH_FILE = `e2e/.auth/admin${E2E_SUFFIX}.json`;

/** The port the statement-pull test's stand-in for Jenga listens on (see e2e/statement-pull.spec.ts and the seed). */
export const FAKE_BANK_PORT = 3199;
