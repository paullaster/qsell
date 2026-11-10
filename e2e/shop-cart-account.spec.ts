import { expect, test } from '@playwright/test';
import { attemptTag, makeShopper, signInAsShopper, signedOutPage } from './support/vendors';
import { noHorizontalScroll } from './support/page';

test.describe('the cart follows a signed-in shopper', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a cart made on one device is there on another, and one made as a guest joins the account at sign-in', async ({ page, browser }, testInfo) => {
    const shopper = makeShopper(attemptTag(testInfo.project.name, testInfo.retry), 0);

    // As a guest: put Rice 5kg in the cart, then sign in. The cart must still hold it, now on the account.
    await page.goto('/?q=Rice 5kg');
    const add = page.getByRole('button', { name: 'Add Rice 5kg to cart' }).first();
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.click();
    await signInAsShopper(page, shopper);
    await page.goto('/');
    await page.getByRole('button', { name: 'Shopping Cart' }).click();
    await expect(page.getByText('Rice 5kg').first()).toBeVisible({ timeout: 30_000 });

    // Give the browser a moment to send the cart, then open a second device (a fresh browser with nothing in it).
    await page.waitForTimeout(1500);
    const other = await signedOutPage(browser, testInfo);
    try {
      await signInAsShopper(other.page, shopper);
      await other.page.goto('/');
      await other.page.getByRole('button', { name: 'Shopping Cart' }).click();
      await expect(other.page.getByText('Rice 5kg').first()).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(other.page);
    } finally {
      await other.close();
    }
  });
});

test.describe('stopping cart reminders', () => {
  test('a link with a wrong token is not found, and a well-formed one that matches no cart says so', async ({ page }) => {
    const missing = await page.goto('/cart/reminders-off?token=short');
    expect(missing?.status()).toBe(404);
    await page.goto(`/cart/reminders-off?token=${'x'.repeat(43)}`);
    await expect(page.getByRole('heading', { name: 'Stop cart reminders' })).toBeVisible({ timeout: 30_000 });
    // The page alone changes nothing: the person presses the button.
    await expect.poll(() => page.getByRole('button', { name: 'Stop reminders' }).evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
    await page.getByRole('button', { name: 'Stop reminders' }).click();
    // The page's own message (the framework's route announcer is also an alert).
    await expect(page.getByRole('alert').filter({ hasText: 'This link is not valid.' })).toHaveText('This link is not valid.', { timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
