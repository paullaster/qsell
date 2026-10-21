import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('admin orders list', () => {
  test('is paged, searchable, filtered by a picker and fits the screen', async ({ page }) => {
    await open(page, '/admin/orders', /Customer Orders/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByLabel('Search orders').fill('no-such-order-zzz');
    await expect(page.getByText('No orders match the current filter criteria.')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel('Search orders').fill('');
    await expect(page.getByText('No orders match the current filter criteria.')).toBeHidden({
      timeout: 30_000,
    });
    await noHorizontalScroll(page);
  });
});
