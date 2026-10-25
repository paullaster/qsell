import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

test.describe('a shopper’s account', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('orders, addresses and the way back all work; payment methods are gone; others’ orders stay hidden', async ({
    page,
  }, testInfo) => {
    test.slow();
    const shopper = makeShopper(attemptTag(testInfo.project.name, testInfo.retry), 12);
    await signInAsShopper(page, shopper);
    await expect(page.getByRole('heading', { name: 'My Account', level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // The account page links only to screens that exist.
    await expect(page.getByRole('link', { name: /Payment Methods/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Wishlist/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to shop' })).toBeVisible();
    await noHorizontalScroll(page);

    // Orders: a page at a time, newest first, with a way back.
    await page.getByRole('link', { name: /My Orders/ }).click();
    await expect(page.getByRole('heading', { name: 'My orders', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    const list = page.getByRole('list', { name: 'Your orders' });
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem')).toHaveCount(10);
    await expect(list.getByRole('listitem').first()).toContainText(shopper.numbers[0] ?? '');
    await expect(page.getByText(shopper.otherNumber)).toHaveCount(0);
    await expect(page.getByText('INTERNAL-')).toHaveCount(0);
    await noHorizontalScroll(page);
    // The page can be drawn before its button is wired up, and an early click does nothing: click again until the rest arrives.
    await expect(async () => {
      if ((await list.getByRole('listitem').count()) < 12) await page.getByRole('button', { name: 'Show older orders' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(12, { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Show older orders' })).toHaveCount(0);

    // One order: its details, and the way back to the list.
    await list.getByRole('link').first().click();
    await expect(
      page.getByRole('heading', {
        name: `Order ${shopper.numbers[0] ?? ''}`,
        level: 2,
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Solar lamp')).toBeVisible();
    await expect(page.getByText('1 Moi Avenue, Nairobi, Nairobi, Kenya')).toBeVisible();
    await expect(page.getByText('INTERNAL-')).toHaveCount(0);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: /Back to My orders/ }).click();
    await expect(page.getByRole('heading', { name: 'My orders', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('link', { name: /Back to My account/ }).click();
    await expect(page.getByRole('heading', { name: 'My Account', level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // Somebody else's order is simply not found.
    await page.goto(`/profile/orders/${shopper.otherId}`);
    await expect(page.getByRole('heading', { name: /not found/i }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(shopper.otherNumber)).toHaveCount(0);

    // Addresses: add, make the delivery address, remove.
    await page.goto('/profile/addresses');
    await expect(page.getByRole('heading', { name: 'My addresses', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    const add = page.getByRole('button', { name: 'Add an address' });
    await expect(async () => {
      await add.click();
      await expect(page.getByLabel('Name this address')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.locator('p[role="alert"]')).toContainText('Name this address');
    const fill = async (label: string, value: string) =>
      await page.getByLabel(label, { exact: true }).fill(value);
    await fill('Name this address', 'Home');
    await fill('Recipient', 'Ann Shopper');
    await fill('Recipient phone', '0712345678');
    await fill('Street or building', '5 Kenyatta Avenue');
    await fill('Town or city', 'Nairobi');
    await fill('County or state', 'Nairobi');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible({ timeout: 30_000 });
    const second = page.getByRole('button', { name: 'Add an address' });
    await second.click();
    await fill('Name this address', 'Office');
    await fill('Recipient', 'Ann Shopper');
    await fill('Recipient phone', '0712345678');
    await fill('Street or building', '9 Haile Selassie');
    await fill('Town or city', 'Nairobi');
    await fill('County or state', 'Nairobi');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Office')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Use for delivery' }).click();
    await expect(page.getByText('Delivery address updated.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Remove address Home' }).click();
    await page.getByRole('button', { name: 'Confirm: Remove address Home' }).click();
    await expect(page.getByText('Address removed.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Remove address/ })).toHaveCount(0);
    await page.getByRole('link', { name: /Back to My account/ }).click();
    await expect(page.getByRole('heading', { name: 'My Account', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
  });

  test('a visitor who is not signed in is asked to sign in, not shown a missing page', async ({
    page,
  }) => {
    for (const path of ['/profile/orders', '/profile/addresses']) {
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('link', { name: /Back to My account/ })).toBeVisible();
      await noHorizontalScroll(page);
    }
  });
});
