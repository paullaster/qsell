import { expect, test } from '@playwright/test';

test('product save and share controls work with mobile taps', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () => {
        document.documentElement.dataset.shareInvoked = 'true';
        return Promise.resolve();
      },
    });
  });

  await page.goto('/');
  const cardSave = page.getByRole('button', { name: 'Save Rice 5kg for later' });
  await expect(cardSave).toBeVisible({ timeout: 30_000 });
  await cardSave.click();
  await expect(
    page.getByRole('button', { name: 'Remove Rice 5kg from saved products' }),
  ).toHaveAttribute('aria-pressed', 'true');

  const productLink = page
    .getByRole('list', { name: 'Products' })
    .getByRole('link', { name: 'Rice 5kg' })
    .first();
  await productLink.click();
  const detailSave = page.getByRole('button', {
    name: 'Remove Rice 5kg from saved products',
  });
  await expect(detailSave).toBeVisible();
  await detailSave.click();
  await expect(page.getByRole('button', { name: 'Save Rice 5kg for later' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-share-invoked', 'true');
});
