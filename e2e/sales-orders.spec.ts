import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeLunchPackage, makeProduct, makeTradeCustomer } from './support/storefront-fixtures';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('sales orders taken by staff', () => {
  test('staff take an order for a credit customer with a product and a package, see their credit, and an order over the limit is refused', async ({ page }, testInfo) => {
    test.slow();
    const tag = `so${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const customer = makeTradeCustomer(tag, '1000000', 21);
    const small = makeTradeCustomer(`${tag}s`, '500', 30);
    const productName = makeProduct(tag);
    const lunch = makeLunchPackage(tag);

    await gotoAdmin(page, '/admin/sales-orders', 'Sales orders');
    await expect(page.getByLabel('Find a sales order')).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    await expect(async () => {
      await page.getByRole('button', { name: 'New sales order' }).click();
      await expect(page.getByRole('form', { name: 'New sales order' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const form = page.getByRole('form', { name: 'New sales order' });

    // The customer, and where they stand for credit.
    await pick(page, form.getByRole('combobox', { name: /Customer/ }), customer);
    await expect(form.getByTestId('credit-position')).toContainText('credit account on 21 days', { timeout: 30_000 });
    await expect(form.getByTestId('credit-position')).toContainText('available');

    // A product, then a package chosen with the shop's builder.
    await pick(page, form.getByRole('combobox', { name: 'Add a product' }), productName);
    await expect(form.getByTestId('order-line')).toHaveCount(1);
    await form.getByLabel(`Quantity of ${productName}`).fill('3');
    await form.getByRole('button', { name: 'Add a package' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a package' });
    await expect(dialog).toBeVisible();
    await pick(page, dialog.getByRole('combobox', { name: 'Package' }), lunch.name);
    await expect(dialog.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Add to the order' }).click();
    await expect(form.getByTestId('order-line')).toHaveCount(2);
    await expect(form.getByTestId('order-totals')).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    await form.getByRole('button', { name: 'Place order' }).click();
    const placed = page.getByTestId('order-placed');
    await expect(placed).toContainText('placed', { timeout: 60_000 });
    const number = /Sales order (\S+) placed/.exec((await placed.textContent()) ?? '')?.[1] ?? '';
    expect(number).not.toBe('');
    // The new order is first in the list, and the search finds it by the customer.
    await expect(page.getByTestId('sales-order').first()).toContainText(number, { timeout: 30_000 });
    await expect(page.getByTestId('sales-order').first()).toContainText(customer);
    await page.getByLabel('Find a sales order').fill(customer);
    await expect(page.getByTestId('sales-order')).toHaveCount(1, { timeout: 30_000 });

    // A customer whose limit is small: the order is refused in words, nothing is placed.
    await page.getByLabel('Find a sales order').fill('');
    await page.getByRole('button', { name: 'New sales order' }).click();
    const second = page.getByRole('form', { name: 'New sales order' });
    await pick(page, second.getByRole('combobox', { name: /Customer/ }), small);
    await expect(second.getByTestId('credit-position')).toContainText('Limit', { timeout: 30_000 });
    await pick(page, second.getByRole('combobox', { name: 'Add a product' }), productName);
    await second.getByLabel(`Quantity of ${productName}`).fill('3');
    await second.getByRole('button', { name: 'Place order' }).click();
    await expect(second.getByTestId('order-problem')).toContainText('would exceed the credit limit', { timeout: 60_000 });
    await expect(second).toBeVisible();
  });
});
