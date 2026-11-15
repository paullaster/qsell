import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

async function cartWithSalt(page: Page): Promise<void> {
  await page.goto('/?q=Salt 500g');
  const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('the address follows the place chosen at checkout', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a signed-in shopper who uses their location is delivered to that place, and it is kept in their book to use again', async ({ page, context }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    deliveryTool('open', tag);
    const shopper = makeShopper(tag, 0, true);
    const savedStreet = `${tag} Saved Close`;
    try {
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation({ latitude: -1.2921, longitude: 36.8219 });
      await signInAsShopper(page, shopper);
      await cartWithSalt(page);
      await page.goto('/checkout');
      await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
      const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
      await expect(section).toBeVisible({ timeout: 30_000 });
      const saved = page.getByRole('list', { name: 'Your saved addresses' });
      await expect(saved).toContainText(savedStreet, { timeout: 30_000 });
      await expect(saved.getByRole('button', { pressed: true })).toContainText(savedStreet);

      // Their location is a new place: the saved address that was picked no longer stands for the delivery.
      await section.getByRole('button', { name: 'Use my location' }).click();
      await expect(section.getByRole('button', { name: 'Remove the pin' })).toBeVisible({ timeout: 30_000 });
      await expect(saved.getByRole('button', { pressed: true })).toHaveCount(0);
      const street = page.getByLabel('Street, building or office');
      await expect(street).toBeVisible();
      await expect(street).not.toHaveValue(savedStreet);
      await expect(section.getByRole('status').filter({ hasText: 'Delivery from' })).toBeVisible({ timeout: 30_000 });

      // Choosing the saved address again puts back its own place (it has none), so the pin is gone and the charge is for the written address.
      await saved.getByRole('button', { name: new RegExp(savedStreet) }).click();
      await expect(section.getByRole('button', { name: 'Remove the pin' })).toHaveCount(0);
      await expect(saved.getByRole('button', { pressed: true })).toContainText(savedStreet);

      // Their location again; the street cannot be left empty, and is asked for next to the pin.
      await section.getByRole('button', { name: 'Use my location' }).click();
      await expect(section.getByRole('button', { name: 'Remove the pin' })).toBeVisible({ timeout: 30_000 });
      await expect(street).not.toHaveValue(savedStreet);
      await street.fill('');
      await page.getByLabel(/number to pay from$/).fill('0733 555 666');
      await page.getByRole('button', { name: /^Pay / }).click();
      await expect(page.locator('form').getByRole('alert').first()).toContainText('Write the street or building next to your pin');
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);

      const pinned = `Pinned Lane ${tag}`;
      await street.fill(pinned);
      await page.getByLabel('City or town').fill('Nairobi');
      await page.getByLabel('County or region').fill('Nairobi');
      await page.getByRole('button', { name: /^Pay / }).click();
      const failed = page.getByRole('region', { name: 'Payment not completed' });
      const waiting = page.getByRole('region', { name: 'Waiting for payment' });
      await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
      const text = await page.locator('main, body').first().innerText();
      const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1];
      expect(orderNumber, 'the page names the order').toBeTruthy();

      // The order goes where the charge was worked out: the place they chose, in the words they gave, not the saved address.
      const kept = deliveryTool('order', orderNumber ?? '');
      expect(kept.ship_street).toBe(pinned);
      expect(kept.ship_street).not.toBe(savedStreet);
      expect(kept.destination).toContain('-1.2921');
      expect(kept.destination).toContain('36.8219');

      // It is in their book now, with its place, so it can be chosen next time.
      await page.goto('/profile/addresses');
      await expect(page.getByRole('heading', { name: 'My addresses', level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(pinned)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(savedStreet)).toBeVisible();

      // A later checkout: choosing that address brings its place back, so the charge and the delivery are for the same place.
      await cartWithSalt(page);
      await page.goto('/checkout');
      const again = page.getByRole('list', { name: 'Your saved addresses' });
      await expect(again).toContainText(pinned, { timeout: 30_000 });
      await again.getByRole('button', { name: new RegExp(pinned) }).click();
      const delivery = page.getByRole('group', { name: 'Where to deliver and what it costs' });
      await expect(delivery.getByRole('button', { name: 'Remove the pin' })).toBeVisible({ timeout: 30_000 });
      await expect(delivery.getByRole('status').filter({ hasText: 'Delivery from' })).toBeVisible({ timeout: 30_000 });
      await again.getByRole('button', { name: new RegExp(savedStreet) }).click();
      await expect(delivery.getByRole('button', { name: 'Remove the pin' })).toHaveCount(0);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
