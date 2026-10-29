import { expect, test } from '@playwright/test';
import { attemptTag, makeShopper, signInAsShopper, signedOutPage } from './support/vendors';

test.describe('wishlist sharing across devices', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a customer can open a shared saved-products link on a signed-out device', async ({
    page,
    browser,
  }, testInfo) => {
    const shopper = makeShopper(attemptTag(testInfo.project.name, testInfo.retry), 0);
    await signInAsShopper(page, shopper);
    await page.goto('/');

    const save = page.getByRole('button', { name: 'Save Rice 5kg for later' });
    await expect(save).toBeVisible({ timeout: 30_000 });
    await save.click();
    await expect(
      page.getByRole('button', { name: 'Remove Rice 5kg from saved products' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.goto('/wishlist');
    await expect(page.getByRole('heading', { name: 'Rice 5kg', level: 3 })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Create share link' }).click();
    await expect(page.getByRole('button', { name: 'Share wishlist' })).toBeVisible({
      timeout: 30_000,
    });
    const sharedUrl = await page.getByLabel('Shareable wishlist link').inputValue();
    expect(sharedUrl).toMatch(/\/wishlist\/shared\/[A-Za-z0-9_-]+$/);

    const visitor = await signedOutPage(browser, testInfo);
    try {
      await visitor.page.goto(sharedUrl);
      await expect(
        visitor.page.getByRole('heading', { name: 'Shared saved products', level: 1 }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        visitor.page.getByRole('list', { name: 'Shared saved products' }).getByRole('link', {
          name: 'Rice 5kg',
        }),
      ).toBeVisible();
    } finally {
      await visitor.close();
    }
  });
});
