import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { makeLimitedProduct } from './support/storefront-fixtures';
import { signedOutPage } from './support/vendors';

const productWindow = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save Changes' }) });

test.describe('a product sold only inside packages', () => {
  test('is on the shop until the flag is set, then it cannot be found, opened or searched for, and the flag takes it off the shop setting', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `po${String(Date.now()).slice(-7)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLimitedProduct(tag, 1, 5);
    const slug = `limited-${tag}`;
    const visitor = await signedOutPage(browser, testInfo);
    try {
      // For sale like any product.
      await visitor.page.goto(`/product/${slug}`);
      await expect(visitor.page.getByRole('heading', { name: made.name, level: 1 })).toBeVisible({ timeout: 60_000 });

      // The person in charge marks it as a part that only a package may sell.
      await page.goto(`/admin/products/${made.id}`);
      const edit = productWindow(page);
      await expect(edit).toBeVisible({ timeout: 60_000 });
      // The web shop settings are on the Media tab.
      await edit.getByRole('button', { name: 'Media' }).click();
      const shopBox = edit.getByLabel(/Show in the web shop/);
      const flag = edit.getByLabel(/Sold only inside packages/);
      await expect(shopBox).toBeChecked();
      await expect(shopBox).toBeEnabled();
      await flag.check();
      // A part that is sold only inside packages is never in the shop, so that setting is switched off and cannot be turned on.
      await expect(shopBox).not.toBeChecked();
      await expect(shopBox).toBeDisabled();
      await edit.getByRole('button', { name: 'Save Changes' }).click();
      await expect(productWindow(page)).toBeHidden({ timeout: 30_000 });

      // Its own address answers "not found", and the shop does not list or search it.
      await expect(async () => {
        const response = await visitor.page.goto(`/product/${slug}`);
        expect(response?.status()).toBe(404);
      }).toPass({ timeout: 60_000 });
      await visitor.page.goto(`/?q=${encodeURIComponent(made.name)}`);
      await expect(visitor.page.getByText('No products found')).toBeVisible({ timeout: 30_000 });
      // The page repeats what was typed in a "Search: ..." chip, so look for a link to the product itself.
      await expect(visitor.page.locator(`a[href*="${slug}"]`)).toHaveCount(0);
      const sitemap = await (await visitor.page.request.get('/sitemap.xml')).text();
      expect(sitemap).not.toContain(slug);
      await noHorizontalScroll(visitor.page);

      // The product is still there for the people who run the business.
      await page.goto(`/admin/products/${made.id}`);
      await expect(productWindow(page)).toBeVisible({ timeout: 60_000 });
      await productWindow(page).getByRole('button', { name: 'Media' }).click();
      await expect(productWindow(page).getByLabel(/Sold only inside packages/)).toBeChecked({ timeout: 30_000 });
    } finally {
      await visitor.close();
    }
  });
});
