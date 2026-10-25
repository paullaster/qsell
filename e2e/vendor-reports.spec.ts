import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { invoiceTool } from './support/vendors';

test.describe('vendor reports', () => {
  test('commitments, performance, purchases and the watch list open, fit the screen and respond to a date range', async ({ page }) => {
    test.slow();
    invoiceTool('prepare');
    await open(page, '/admin/vendors/reports', 'Vendor reports');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    const panel = page.getByRole('tabpanel', { name: 'Commitments' });
    await expect(panel.getByText(/Open orders: ordered/)).toBeVisible({ timeout: 60_000 });
    await noInnerHorizontalScroll(page);

    await page.getByRole('tab', { name: 'Performance' }).dispatchEvent('click');
    const performance = page.getByRole('tabpanel', { name: 'Performance' });
    await expect(performance.getByLabel('From')).toBeVisible({ timeout: 60_000 });
    await expect(performance.getByText('Loading…')).toBeHidden({ timeout: 60_000 });
    await performance.getByLabel('From').fill('2000-01-01');
    await performance.getByLabel('To').fill('2000-01-02');
    await expect(performance.getByText('Nothing was delivered, invoiced or asked for in this period.')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('tab', { name: 'Purchases' }).dispatchEvent('click');
    const purchases = page.getByRole('tabpanel', { name: 'Purchases' });
    await expect(purchases.getByText(/Booked between/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole('tab', { name: 'Watch list' }).dispatchEvent('click');
    const watch = page.getByRole('tabpanel', { name: 'Watch list' });
    await expect(watch.getByText('These are things to look at, not mistakes. Nothing here blocks or changes a document.')).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
