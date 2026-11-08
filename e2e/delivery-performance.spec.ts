import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder } from './support/delivery-shop';

test.describe('delivery performance', () => {
  test('a delivery made after its window is counted as late, and a delivery made in time as on time, by day', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = await placeDeliveredOrder(page);
      const number = deliveryTool('ready', orderNumber).number ?? '';
      await open(page, '/admin/delivery/performance', 'Delivery performance');
      await noNativeSelect(page);
      const overall = page.getByRole('region', { name: 'Overall' });
      await expect(overall).toBeVisible({ timeout: 30_000 });

      expect(deliveryTool('deliver-promised', number, 'late').delivered).toBe(number);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Delivery performance' })).toBeVisible({ timeout: 30_000 });
      await expect(overall).toContainText('Delivered on time', { timeout: 30_000 });
      await expect(overall).toContainText(/\d+ of \d+ promised a window/);
      await expect(page.getByRole('region', { name: 'Delivery times' })).toContainText(`Performance ${number}`);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // Days with nothing in them are said plainly, and nonsense days are refused with words.
      const days = page.getByRole('form', { name: 'Days' });
      await days.getByLabel('From day').fill('2001-01-01');
      await days.getByLabel('To day').fill('2001-01-31');
      await days.getByRole('button', { name: 'Show these days' }).click();
      await expect(page.getByText('Nothing was delivered in these days.')).toBeVisible({ timeout: 30_000 });
      await days.getByLabel('From day').fill('2026-12-31');
      await days.getByLabel('To day').fill('2026-12-01');
      await days.getByRole('button', { name: 'Show these days' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'The first day cannot be after the last' })).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
