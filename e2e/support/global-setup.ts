import { execFileSync } from 'node:child_process';
import { chromium, request, type FullConfig } from '@playwright/test';
import { AUTH_FILE, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_URL } from './constants';
import { e2eEnvironment } from './env';

/**
 * Before the tests: bring the end-to-end database up to date with the migrations, seed it, and
 * sign in once as the admin so every test starts signed in.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const env = { ...process.env, ...e2eEnvironment() };
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { env, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/seed.ts'], { env, stdio: 'inherit' });

  // The first compile of the sign-in route can take longer than the default 30 seconds.
  const api = await request.newContext({ baseURL: E2E_URL, timeout: 300_000 });
  // A connection cut while the server is still compiling is tried again, as the warm-up below is.
  let response = null;
  for (let attempt = 1; attempt <= 4 && response === null; attempt += 1) {
    try {
      const csrf = (await (await api.get('/api/auth/csrf')).json()) as { csrfToken: string };
      response = await api.post('/api/auth/callback/credentials', {
        form: { csrfToken: csrf.csrfToken, email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD, callbackUrl: `${E2E_URL}/admin` },
      });
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  if (!(response?.ok() ?? false)) throw new Error(`e2e sign-in failed: ${String(response?.status())}`);
  await api.storageState({ path: AUTH_FILE });
  await api.dispose();
  await warmUp();
}

/**
 * The development server compiles a route the first time it is visited, which can take minutes.
 * Visit the routes the tests use once, here, so no test pays for it (and times out).
 */
async function warmUp(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ storageState: AUTH_FILE, baseURL: E2E_URL });
  const page = await context.newPage();
  const routes = ['/admin/quotes', '/admin/quotes/templates', '/admin/quotes/section-templates'];
  for (const route of routes) {
    // A warm-up that is cut short (the machine's network changed while the page loaded) is tried again, not fatal.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await page.goto(route, { timeout: 300_000 });
        await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 300_000 });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
  }
  // The vendor screens compile on their first visit, which can take minutes and reload the page under a test. Visit each once here
  // (a made-up id compiles a record page too); a visit that is cut short is not a failure of the set-up.
  const fake = '00000000-0000-4000-8000-000000000000';
  const vendorRoutes = ['/login?callbackUrl=%2Fvendor', '/admin/vendors', `/admin/vendors/${fake}`, '/admin/vendors/rfqs', '/admin/vendors/rfqs/new', `/admin/vendors/rfqs/${fake}`, `/admin/vendors/rfqs/${fake}/quotes`, '/admin/vendors/orders', '/admin/vendors/orders/new', `/admin/vendors/orders/${fake}`, '/admin/vendors/receipts', '/admin/vendors/receipts/new', `/admin/vendors/receipts/${fake}`, '/admin/vendors/receipts/not-invoiced', '/admin/vendors/invoices', `/admin/vendors/invoices/${fake}`, '/admin/vendors/payments', '/admin/vendors/payments/new', '/admin/vendors/payments/runs', '/admin/vendors/payment-rules', '/admin/vendors/reports', '/admin/vendors/refunds', '/admin/vendors/returns', '/admin/vendors/requisitions', '/admin/vendors/contracts', '/admin/vendors/landed-costs', '/admin/vendors/scorecards', '/admin/vendors/landed-costs/new', `/admin/vendors/landed-costs/${fake}`, '/admin/vendors/contracts/new', `/admin/vendors/contracts/${fake}`, '/admin/vendors/requisitions/new', `/admin/vendors/requisitions/${fake}`, `/admin/vendors/returns/${fake}`, `/admin/vendors/refunds/${fake}`, '/admin/vendors/petty-cash', `/admin/vendors/petty-cash/${fake}`, '/admin/vendors/petty-cash/vouchers/new', `/admin/vendors/petty-cash/vouchers/${fake}`, '/admin/vendors/credit-memos', `/admin/vendors/credit-memos/${fake}`, '/admin/vendors/certificates', `/admin/vendors/certificates/${fake}`, '/admin/vendors/payments/runs/new', `/admin/vendors/payments/runs/${fake}`, `/admin/vendors/payments/${fake}`, '/admin/vendors/payables', `/admin/vendors/payables/${fake}`, '/admin/vendors/categories', `/admin/vendors/categories/${fake}`, '/admin/vendors/prequalification', `/admin/vendors/prequalification/${fake}`, '/admin/vendors/bank-changes', '/admin/vendors/expiring', '/admin/vendors/document-types', '/admin/vendors/review', '/admin/vendors/settings'];
  for (const route of vendorRoutes) {
    try {
      await page.goto(route, { timeout: 300_000, waitUntil: 'load' });
      await page.waitForTimeout(1000);
    } catch {
      // Tried again by the tests themselves.
    }
  }
  // A product opens in a dialog through a soft navigation, which compiles its own route the first time. A click that comes
  // before that finishes fails to fetch and falls back to a plain page load, so open one product here and wait.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await page.goto('/admin/products', { timeout: 300_000 });
      break;
    } catch (error) {
      if (attempt === 4) console.warn('e2e warm-up: /admin/products was cut short; continuing', String(error));
    }
  }
  // Only a warm-up: a click cut short by a network flap must not stop the whole run.
  await page.getByText('Rice 5kg', { exact: true }).first().click({ timeout: 120_000 }).catch(() => undefined);
  await page.getByRole('dialog').waitFor({ timeout: 120_000 }).catch(() => undefined);
  await browser.close();
}
