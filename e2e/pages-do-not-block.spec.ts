import { expect, test } from '@playwright/test';
import { E2E_URL } from './support/constants';

/**
 * The finance actions are slowed (the server honours an `e2e-delay` cookie, only in this test
 * server). A screen must show its own loading state at once, and its access check and its data must
 * be fetched side by side: with both slowed by DELAY, the screen is ready in about DELAY, not twice it.
 */
const DELAY = 3000;

const screens: [string, string, RegExp, string | RegExp][] = [
  ['wallet policy', '/admin/finance/receivables/wallet-policy', /Loading the wallet policy/, 'Wallet policy'],
  ['receipts', '/admin/finance/receipts', /Loading receipts/, 'Customer receipts'],
  ['new refund', '/admin/finance/refunds/new', /Loading the refund form/, 'New refund'],
  ['bank accounts', '/admin/finance/bank-accounts', /Loading bank accounts/, 'Bank and cash accounts'],
  ['returns', '/admin/finance/receivables/returns', /Loading returns/, 'Returns'],
  ['dimensions', '/admin/settings/dimensions', /Loading dimensions/, 'Dimensions'],
  ['number series', '/admin/settings/number-series', /Loading number series/, 'Number series'],
  ['document numbering', '/admin/settings/number-series/bindings', /Loading document numbering/, 'Document numbering'],
  ['payment settings', '/admin/settings/payments', /Loading payment settings/, 'Payments'],
];

for (const [name, url, skeleton, heading] of screens) {
  test(`${name} shows its loading state at once and loads in parallel`, async ({ page, context }) => {
    // Visit once without the delay so the development server has built the route, then slow it down.
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading, level: 2 }).first()).toBeVisible({ timeout: 60_000 });
    await context.addCookies([{ name: 'e2e-delay', value: String(DELAY), url: E2E_URL }]);
    const started = Date.now();
    await page.goto(url, { waitUntil: 'commit' });
    await expect(page.getByRole('status').filter({ hasText: skeleton })).toBeVisible({ timeout: DELAY - 500 });
    const shownAfter = Date.now() - started;
    expect(shownAfter).toBeLessThan(DELAY);
    await expect(page.getByRole('heading', { name: heading, level: 2 }).first()).toBeVisible({ timeout: DELAY * 2 });
    // Side by side: about one delay, with room for the machine, but well short of two.
    expect(Date.now() - started).toBeLessThan(DELAY * 2 - 200);
  });
}
