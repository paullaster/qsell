import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct, makeTradeCustomer } from './support/storefront-fixtures';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('credit sales', () => {
  test('staff sell to a customer\'s account: the credit position shows, the invoice is made with the sale, and a sale over the limit is refused', async ({ page }, testInfo) => {
    test.slow();
    const tag = `cs${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const customer = makeTradeCustomer(tag, '1000000', 21);
    const small = makeTradeCustomer(`${tag}s`, '500', 30);
    const productName = makeProduct(tag);

    await gotoAdmin(page, '/admin/credit-sales', 'Credit sales');
    await expect(page.getByLabel('Find a credit sale')).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(async () => {
      await page.getByRole('button', { name: 'New credit sale' }).click();
      await expect(page.getByRole('form', { name: 'New credit sale' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const form = page.getByRole('form', { name: 'New credit sale' });

    // Only customers with a credit account are offered, and their position shows; there is no payment to choose.
    await pick(page, form.getByRole('combobox', { name: /Customer/ }), customer);
    await expect(form.getByTestId('credit-position')).toContainText('credit account on 21 days', { timeout: 30_000 });
    await expect(form.getByRole('combobox', { name: 'Expected payment' })).toHaveCount(0);
    await expect(form).toContainText('Paid by the customer on their account terms');
    await pick(page, form.getByRole('combobox', { name: 'Add a product' }), productName);
    await form.getByLabel(`Quantity of ${productName}`).fill('2');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await form.getByRole('button', { name: 'Place credit sale' }).click();
    const placed = page.getByTestId('order-placed');
    await expect(placed).toContainText('Credit sale', { timeout: 60_000 });
    await expect(placed).toContainText('with invoice');
    const number = /Credit sale (\S+) placed/.exec((await placed.textContent()) ?? '')?.[1] ?? '';
    expect(number).not.toBe('');
    await expect(page.getByTestId('sales-order').first()).toContainText(number, { timeout: 30_000 });
    await expect(page.getByTestId('sales-order').first()).toContainText(customer);

    // A sale over a small limit is refused in words and nothing is placed.
    await page.getByRole('button', { name: 'New credit sale' }).click();
    const second = page.getByRole('form', { name: 'New credit sale' });
    await pick(page, second.getByRole('combobox', { name: /Customer/ }), small);
    await expect(second.getByTestId('credit-position')).toContainText('Limit', { timeout: 30_000 });
    await pick(page, second.getByRole('combobox', { name: 'Add a product' }), productName);
    await second.getByLabel(`Quantity of ${productName}`).fill('3');
    await second.getByRole('button', { name: 'Place credit sale' }).click();
    await expect(second.getByTestId('order-problem')).toContainText('would exceed the credit limit', { timeout: 60_000 });
  });
});
