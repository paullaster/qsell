import { expect, test } from '@playwright/test';
import { gotoAdmin } from './support/quotes';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';

// On a phone every list reads as cards: nothing sits behind a sideways scroll bar.
test.describe('phone layout of the lists', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'Only the phone layout is checked here.');
  });

  test('the quotes list and the templates list stack as cards', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await expect(page.getByRole('table').first().getByRole('row').nth(1)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await expect(async () => {
      await page.getByRole('tab', { name: 'Templates', exact: true }).click();
      await expect(page.getByRole('searchbox', { name: 'Search templates' })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 90_000 });
    await expect(page.getByRole('table').getByRole('row').nth(1)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  for (const [url, heading] of [
    ['/admin/transactions/ledger', /ledger/i],
    ['/admin/transactions/reconcile', /reconcil/i],
  ] as const) {
    test(`${url} needs no sideways scrolling`, async ({ page }) => {
      await gotoAdmin(page, url, heading);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    });
  }
});
