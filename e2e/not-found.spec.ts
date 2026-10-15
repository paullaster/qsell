import { expect, test } from '@playwright/test';

/**
 * A record that is not there gets the not-found page, not an error message inside a working-looking
 * screen: for an id that could exist and for an address that could never be an id.
 */
const SCREENS = [
  '/admin/finance/receipts',
  '/admin/finance/journals',
  '/admin/finance/refunds',
  '/admin/finance/receivables/returns',
  '/admin/finance/receivables/customer',
  '/admin/finance/bank-statements',
  '/admin/settings/dimensions',
  '/admin/settings/number-series',
  '/admin/settings/approvals/workflows',
  '/admin/pricing/lists',
  '/admin/pricing/discounts',
  '/admin/pricing/rebates',
];
const MISSING = ['00000000-0000-4000-8000-000000000000', 'not-an-id'];

for (const base of SCREENS) {
  for (const id of MISSING) {
    test(`${base}/${id} is not found`, async ({ page }) => {
      await page.goto(`${base}/${id}`);
      await expect(page.getByRole('heading', { name: 'Not found', level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
      await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
