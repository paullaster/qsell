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

      await where.getByText('Change the street, the place on the map, who receives it, or the note').click();
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

      // The place on the map: what the customer shared is pasted (a map link here), read in words when it is not a place, and it can be taken off.
      await after.getByText('Change the street, the place on the map, who receives it, or the note').click();
      const place = after.getByLabel('Place on the map');
      await expect(place).toHaveValue('-1.2864, 36.8172');
      await place.fill('near the big baobab');
      await after.getByRole('button', { name: 'Save these details' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'could not find a place' })).toBeVisible({ timeout: 30_000 });
      // Nothing was changed by the refusal: the place the checkout recorded is still there.
      await expect(after).toContainText('Pin -1.2864, 36.8172');
      await place.fill('https://www.google.com/maps/place/Home/@-1.2921,36.8219,17z/data=!4m5');
      await after.getByRole('button', { name: 'Save these details' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'The details are changed.' })).toBeVisible({ timeout: 30_000 });
      await expect(after).toContainText('Pin -1.2921, 36.8219');
      await page.reload();
      const pinned = page.getByRole('region', { name: 'Where it goes' });
      await expect(pinned).toContainText('Pin -1.2921, 36.8219', { timeout: 30_000 });
      await pinned.getByText('Change the street, the place on the map, who receives it, or the note').click();
      await expect(pinned.getByLabel('Place on the map')).toHaveValue('-1.2921, 36.8219');
      await pinned.getByLabel('Place on the map').fill('');
      await pinned.getByRole('button', { name: 'Save these details' }).click();
      await expect(pinned).not.toContainText('Pin ', { timeout: 30_000 });
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
  test('a delivery that has not gone out is cancelled when its order is cancelled, and says why in its history', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}X`;
    deliveryTool('open', tag);
    try {
      const orderNumber = deliveryTool('courier-order', tag).orderNumber ?? '';
      const made = deliveryTool('ready', orderNumber);
      const number = made.number ?? '';
      deliveryTool('cancel-order', orderNumber);
      expect(Number(deliveryTool('close-closed', tag).deliveries)).toBeGreaterThanOrEqual(1);
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('region', { name: 'History' })).toContainText('The order was cancelled or refunded, so the delivery is cancelled.');
      await expect(page.getByRole('button', { name: 'Send out' })).toHaveCount(0);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
