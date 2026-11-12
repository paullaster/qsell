import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { makeLunchPackage } from './support/storefront-fixtures';

const total = (page: Page) => page.getByTestId('package-total');

/** The page is drawn before it is wired up; a click in that moment does nothing, so try again until the choice shows. */
async function choose(page: Page, name: RegExp, role: 'radio' | 'checkbox'): Promise<void> {
  const card = page.getByRole(role, { name });
  await expect(async () => {
    await card.click();
    await expect(card).toBeChecked({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });
}

async function openCart(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'Shopping Cart' }).click();
    await expect(page.getByRole('heading', { name: 'Your Cart', exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('configurable packages in the web shop', () => {
  test('a shopper builds a package, sees the price move with each choice, hears what stock allows, then edits it in the cart and cannot check out with it yet', async ({ page }, testInfo) => {
    test.slow();
    const tag = `ps${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLunchPackage(tag);

    await page.goto(`/product/${made.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: made.name })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });

    // The rules in words, the defaults chosen, the price of the defaults, and no sold-out option on show.
    await expect(page.getByRole('group', { name: 'Vegetables' })).toBeVisible();
    await expect(page.getByText('Choose 1 to 2')).toBeVisible();
    await expect(page.getByRole('radio', { name: new RegExp(made.large) })).toBeChecked();
    await expect(page.getByRole('radio', { name: new RegExp(made.ugali) })).toBeChecked();
    await expect(page.getByRole('radio', { name: new RegExp(made.brown) })).toHaveCount(0);
    await expect(total(page)).toContainText('770');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The price follows every choice.
    await choose(page, new RegExp(made.small), 'radio');
    await expect(total(page)).toContainText('650');
    await choose(page, new RegExp(made.cabbage), 'checkbox');
    await expect(total(page)).toContainText('660');

    // A choice the package needs: Add is off, and says why.
    await page.getByRole('checkbox', { name: new RegExp(made.sukuma) }).click();
    await page.getByRole('checkbox', { name: new RegExp(made.cabbage) }).click();
    await expect(page.getByTestId('package-reason')).toContainText('Vegetables');
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeDisabled();
    await choose(page, new RegExp(made.sukuma), 'checkbox');
    await choose(page, new RegExp(made.cabbage), 'checkbox');

    // Stock for several servings: three ugali in stock, so a fourth serving cannot be had.
    const more = page.getByRole('button', { name: 'One more serving' });
    await more.click();
    await more.click();
    await more.click();
    await expect(page.getByTestId('package-reason')).toContainText('sold out', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeDisabled();
    await page.getByRole('button', { name: 'One less serving' }).click();
    await page.getByRole('button', { name: 'One less serving' }).click();
    await expect(total(page)).toContainText('1,320');

    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to your cart').first()).toBeVisible({ timeout: 30_000 });
    await openCart(page);
    const line = page.getByTestId('package-line');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`${made.small}, ${made.ugali}, ${made.sukuma} and ${made.cabbage}`, { timeout: 30_000 });
    await expect(line).toContainText('1,320');
    await noHorizontalScroll(page);

    // Editing a line reopens the builder with the choices kept.
    await line.getByRole('button', { name: 'Edit' }).click();
    await expect(line.getByRole('radio', { name: new RegExp(made.small) })).toBeChecked({ timeout: 30_000 });
    await line.getByRole('radio', { name: new RegExp(made.large) }).click();
    await line.getByRole('button', { name: 'Save changes' }).click();
    await expect(line).toContainText(`${made.large}, ${made.ugali}`, { timeout: 30_000 });
    await expect(line).toContainText('1,560');

    // Servings can change in the cart; the shop checks stock again.
    await line.getByRole('button', { name: 'One more serving' }).click();
    await expect(line).toContainText('sold out for 3 servings', { timeout: 30_000 }).catch(() => undefined);
    await line.getByRole('button', { name: 'One less serving' }).click();

    // Ordering a package opens with the next step: checkout says so plainly rather than leaving it out of an order.
    await page.goto('/checkout');
    await expect(page.getByTestId('packages-not-orderable')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('packages-not-orderable')).toContainText('cannot be ordered here yet');
    await page.getByRole('button', { name: 'Remove this package' }).click();
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible({ timeout: 30_000 });
  });

  test('a package is never added to the cart as it stands, and the parts only packages sell have no page of their own', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pt${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLunchPackage(tag);

    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill(made.name);
    const choose = page.getByRole('link', { name: `Choose options for ${made.name}` });
    await expect(choose).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: `Add ${made.name} to cart` })).toHaveCount(0);

    // A part sold only inside packages is not found in the shop and its own address is not a page.
    await search.fill(made.ugali);
    await expect(page.getByText('No products found')).toBeVisible({ timeout: 30_000 });
    const response = await page.goto(`/product/pk-u-${tag}`);
    expect(response?.status()).toBe(404);
  });
});
