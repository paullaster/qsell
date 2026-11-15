import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';

test.describe('correcting the street of a delivery', () => {
  test('staff see the street the order was written with and can correct it before it goes out, in words, with nothing else about the place changed', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const made = deliveryTool('ready', deliveryTool('courier-order', tag).orderNumber ?? '');
      const number = made.number ?? '';
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      const where = page.getByRole('region', { name: 'Where it goes' });
      // The street the order was written with leads what is shown.
      await expect(where).toContainText('1 Moi Avenue');

      await where.getByText('Change the street, who receives it, or the note').click();
      const street = where.getByLabel('Street or building');
      await expect(street).toBeVisible();
      await expect(where).toContainText('The place on the map and the charge stay as they were');

      // Too short is refused in words, and nothing is saved.
      await street.fill('x');
      await where.getByRole('button', { name: 'Save these details' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'street or building' })).toBeVisible({ timeout: 30_000 });

      // Corrected: shown at once, kept after a reload, and the rest of where it goes is as it was.
      const corrected = `Gate 2, ${tag} Close`;
      await street.fill(corrected);
      await where.getByRole('button', { name: 'Save these details' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'The details are changed.' })).toBeVisible({ timeout: 30_000 });
      await expect(where).toContainText(corrected);
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);
      await page.reload();
      const after = page.getByRole('region', { name: 'Where it goes' });
      await expect(after).toContainText(corrected, { timeout: 30_000 });
      await expect(after).not.toContainText('1 Moi Avenue');
    } finally {
      deliveryTool('close', tag);
    }
  });
});
