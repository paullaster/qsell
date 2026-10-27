import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, open } from './support/page';
import { makeLimitedProduct } from './support/storefront-fixtures';
import { attemptTag } from './support/vendors';

const cartLine = (page: Page) => page.getByRole('dialog', { name: 'Your Cart' });

test.describe('the least and most that can be bought', () => {
  test('the shop starts at the minimum, will not go outside the limits, and says why', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const product = makeLimitedProduct(tag, 3, 10);

    // On the shop page the limits are stated, and adding starts at the minimum.
    await page.goto(`/?q=${product.name}`);
    const card = page.getByRole('list', { name: 'Products' }).getByRole('article').filter({ hasText: product.name });
    await expect(card.getByText('Buy 3 to 10 Piece at a time.')).toBeVisible({ timeout: 60_000 });
    const add = page.getByRole('button', { name: `Add ${product.name} to cart` });
    await expect(async () => {
      await add.click();
      await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('3', { timeout: 3000 });
    }).toPass({ timeout: 60_000 });

    // The product page starts at the minimum; it cannot be stepped below it or above the maximum.
    await card.getByRole('link', { name: product.name }).first().click();
    await expect(page.getByRole('heading', { name: product.name, level: 1 })).toBeVisible({ timeout: 60_000 });
    const quantity = page.getByRole('textbox', { name: `quantity of ${product.name}` }).first();
    await expect(quantity).toHaveValue('3');
    await expect(page.getByRole('button', { name: `Less quantity of ${product.name}` }).first()).toBeDisabled();
    await expect(page.getByText('Buy 3 to 10 Piece at a time.').first()).toBeVisible();

    await quantity.fill('1');
    await quantity.press('Enter');
    await expect(quantity).toHaveValue('3');
    await expect(page.getByText('The least you can buy is 3.')).toBeVisible();
    await quantity.fill('50');
    await quantity.press('Enter');
    await expect(quantity).toHaveValue('10');
    await expect(page.getByText('The most you can buy is 10.')).toBeVisible();
    await expect(page.getByRole('button', { name: `More quantity of ${product.name}` }).first()).toBeDisabled();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  // Each case starts from its own saved cart, so nothing the first one does can write over the second.
  for (const [title, saved, expected, message] of [
    ['a cart saved below the minimum is raised to it, with a notice', 1, 3, (name: string) => `The least you can buy of ${name} is 3, so the quantity was raised.`],
    ['a cart saved above the maximum is cut to it, with a notice', 40, 10, (name: string) => `The most you can buy of ${name} is 10, so the quantity was reduced.`],
  ] as const) {
    test(title, async ({ page }, testInfo) => {
      test.slow();
      const tag = attemptTag(testInfo.project.name, testInfo.retry);
      const product = makeLimitedProduct(tag, 3, 10);
      await page.addInitScript(([id, quantity]) => {
        if (window.sessionStorage.getItem('seeded') === null) {
          window.localStorage.setItem('qsell_cart_v2', JSON.stringify([{ productId: id, quantity, price: 250 }]));
          window.sessionStorage.setItem('seeded', '1');
        }
      }, [product.id, saved] as const);
      await page.goto('/checkout');
      await expect(page.getByText(message(product.name))).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => JSON.parse((await page.evaluate(() => window.localStorage.getItem('qsell_cart_v2'))) ?? '[]') as { productId: string; quantity: number }[], { timeout: 30_000 }).toEqual([expect.objectContaining({ productId: product.id, quantity: expected })]);
    });
  }

  test('the cart drawer stops at the limits too', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const product = makeLimitedProduct(tag, 2, 4);
    await page.goto(`/?q=${product.name}`);
    const add = page.getByRole('button', { name: `Add ${product.name} to cart` });
    await expect(async () => {
      await add.click();
      await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('2', { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Shopping Cart' }).click();
    const drawer = cartLine(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: `Less quantity of ${product.name}` })).toBeDisabled();
    const more = drawer.getByRole('button', { name: `More quantity of ${product.name}` });
    await more.click();
    await more.click();
    await expect(drawer.getByRole('textbox', { name: `quantity of ${product.name}` })).toHaveValue('4');
    await expect(more).toBeDisabled();
  });
});

test.describe('the item form', () => {
  test('quantity limits are empty by default, are checked, and the standard price follows the selling price until set', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const product = makeLimitedProduct(tag, 3, 10);
    await open(page, '/admin/products', /Products|Catalog/);
    await page.getByText(product.name, { exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Pricing' }).click();

    // The limits show what was saved; the standard price is empty and says it follows the selling price.
    await expect(dialog.getByLabel(/Minimum quantity/)).toHaveValue('3');
    await expect(dialog.getByLabel(/Maximum quantity/)).toHaveValue('10');
    const standard = dialog.getByLabel('Standard Price (KES)');
    await expect(standard).toHaveValue('');
    await expect(standard).toHaveAttribute('placeholder', 'Same as the selling price (250)');
    await expect(standard).toBeEnabled();

    // A minimum above the maximum is refused in words, and nothing is saved.
    await dialog.getByLabel(/Minimum quantity/).fill('20');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog.getByText(/cannot be above the maximum/)).toBeVisible();
    await expect(dialog).toBeVisible();

    // Fixed, with a standard price of its own, it saves and is there when the item is opened again.
    await dialog.getByLabel(/Minimum quantity/).fill('2');
    await standard.fill('230');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await page.getByText(product.name, { exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pricing' }).click();
    await expect(page.getByRole('dialog').getByLabel(/Minimum quantity/)).toHaveValue('2');
    await expect(page.getByRole('dialog').getByLabel('Standard Price (KES)')).toHaveValue('230');
    await noHorizontalScroll(page);
  });
});
