import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';

test.describe('stock timing', () => {
  test('shows when stock leaves, explains each choice, and refuses a later moment until stock is kept by location', async ({ page }) => {
    test.slow();
    await open(page, '/admin/delivery/stock', 'Stock timing');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    // The test shop keeps stock the old way, so it can only leave when the order is paid, and the page says so.
    await expect(page.getByRole('status').filter({ hasText: 'not yet kept by location' })).toBeVisible();
    await expect(page.getByText('In use now:')).toContainText('When the order is paid');
    const picker = page.getByRole('combobox', { name: 'The stock of a delivered order leaves the shelf' });
    await pick(page, picker, 'goes out', /When a delivery goes out/);
    await expect(page.getByText('Only what that delivery carries leaves the shelf.')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'kept by location' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('In use now:')).toContainText('When the order is paid');
    await noHorizontalScroll(page);
  });
});
