import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';

test.describe('product specifications on the shop', () => {
  test('what was added in the admin console is shown on the product page, and the page opens from a link and directly', async ({
    page,
  }) => {
    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill('Fish kg Shop');
    const link = page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Fish kg Shop' }).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      // Once the address has changed the click landed; clicking again would restart a slow first compile.
      if (!page.url().includes('/product/')) await link.click();
      await expect(page.getByRole('heading', { name: 'Specifications', level: 2 })).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 100_000 });
    await expect(page.getByRole('term').first()).toHaveText('Origin');
    await expect(page.getByText('Lake Victoria')).toBeVisible();
    await expect(page.getByRole('term').nth(1)).toHaveText('Grade');
    await expect(page.getByRole('definition').nth(1)).toHaveText('A');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The same product opened directly, not from the shop.
    await expect(page).toHaveURL(/\/product\//);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Specifications', level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Lake Victoria')).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('a product with none shows no empty heading', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill('Salt 500g');
    const link = page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Salt 500g' }).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      if (!page.url().includes('/product/')) await link.click();
      await expect(page.getByRole('heading', { name: 'Salt 500g', level: 1 })).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 100_000 });
    await expect(page.getByRole('heading', { name: 'Specifications' })).toHaveCount(0);
  });
});
