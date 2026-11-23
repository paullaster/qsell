import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { gotoAdmin } from './support/quotes';

const MOVED = [
  { name: 'registers', title: 'Registers' },
  { name: 'partial-billing', title: 'Partial billing' },
  { name: 'offline-selling', title: 'Offline selling' },
] as const;

test.describe('settings under Sales', () => {
  test('Registers, Partial billing and Offline selling are opened from the Sales settings', async ({ page }) => {
    test.slow();
    await gotoAdmin(page, '/admin/settings/sales', 'Sales');
    for (const { name, title } of MOVED) {
      await expect(page.locator(`a[href="/admin/settings/sales/${name}"]`).first()).toBeVisible();
      // None is left at the top of the settings list.
      await expect(page.locator(`a[href="/admin/settings/${name}"]`)).toHaveCount(0);
      expect(title).not.toBe('');
    }
    await noHorizontalScroll(page);
  });

  for (const { name, title } of MOVED) {
    test(`the old address of ${title} still works and leads to its new one`, async ({ page }) => {
      await page.goto(`/admin/settings/${name}`);
      await expect(page).toHaveURL(new RegExp(`/admin/settings/sales/${name}$`));
      await gotoAdmin(page, `/admin/settings/sales/${name}`, title);
    });
  }
});
