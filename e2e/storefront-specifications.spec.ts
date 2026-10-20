import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';

test.describe('product specifications on the shop', () => {
  test('what was added in the admin console is shown on the product details, in the pop-up and on the page itself', async ({
    page,
  }) => {
    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill('Fish kg Shop');
    await expect(async () => {
      await page.getByRole('button', { name: 'View Fish kg Shop' }).click();
      await expect(page.getByRole('heading', { name: 'Specifications:' })).toBeVisible({
        timeout: 3000,
      });
    }).toPass({ timeout: 60_000 });
    const list = page.getByRole('term').first();
    await expect(list).toHaveText('Origin');
    await expect(page.getByText('Lake Victoria')).toBeVisible();
    await expect(page.getByRole('term').nth(1)).toHaveText('Grade');
    await expect(page.getByRole('definition').nth(1)).toHaveText('A');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The same product opened directly, not from the shop.
    await expect(page).toHaveURL(/\/product\//);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Specifications:' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Lake Victoria')).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('a product with none shows no empty heading', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill('Salt 500g');
    await expect(async () => {
      await page.getByRole('button', { name: 'View Salt 500g' }).click();
      await expect(page.getByText('Availability:')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Specifications:' })).toHaveCount(0);
  });
});
