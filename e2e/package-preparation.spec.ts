import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { makeLunchOrders } from './support/storefront-fixtures';

test.describe('the preparation sheet', () => {
  test('shows what to make for a day from the choices on each order, with totals, leaves out a cancelled order, and can be printed', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pp${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLunchOrders(tag);

    await open(page, '/admin/orders/preparation', 'Preparation sheet');
    // Move to the day with the orders; the days that have orders are offered too.
    await expect(page.getByRole('navigation', { name: 'Days with orders' })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Day').fill(made.day);
    const sheet = page.getByTestId('preparation-sheet');
    await expect(sheet).toContainText('Totals', { timeout: 60_000 });

    // 3 + 9 servings are kept; the 4 of the cancelled order are not on the sheet.
    const totals = page.getByTestId('preparation-totals');
    await expect(totals).toContainText('12 servings in 2 orders');
    await expect(totals.getByRole('list', { name: 'What to prepare' })).toContainText(made.large);
    await expect(totals.getByRole('listitem').filter({ hasText: made.large })).toContainText('9');
    await expect(totals.getByRole('listitem').filter({ hasText: made.small })).toContainText('3');
    await expect(totals.getByRole('listitem').filter({ hasText: made.ugali })).toContainText('12');

    // Each order's own choices are listed under its package.
    const lines = page.getByTestId('preparation-selection');
    await expect(lines).toHaveCount(2);
    await expect(lines.filter({ hasText: `PREP-${tag.toUpperCase()}-2` })).toContainText(`9 × ${made.large}`);
    await expect(sheet).not.toContainText(`PREP-${tag.toUpperCase()}-3`);

    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A day with nothing says so.
    await page.getByLabel('Day').fill('2031-01-05');
    await expect(sheet).toContainText('Nothing to prepare for this day', { timeout: 30_000 });
  });
});
