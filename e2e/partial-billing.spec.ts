import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct, makeSalesOrder, makeTradeCustomer } from './support/storefront-fixtures';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 120_000 });
}

test.describe('invoicing part of an order', () => {
  test('is switched on in Settings, then an order is invoiced in two parts with numbers of their own, and the order drops out once it is finished', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pb${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const customer = makeTradeCustomer(tag);
    const productName = makeProduct(tag);
    const orderNumber = makeSalesOrder(customer, productName);

    // Off by default: the setting is changed with a reason, in its own screen.
    await gotoAdmin(page, '/admin/settings/partial-billing', 'Partial billing');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(async () => {
      const on = await page.getByText('On', { exact: true }).count();
      if (on > 0) return;
      await page.getByRole('button', { name: 'Switch on' }).click();
      await expect(page.getByRole('form', { name: 'Switch on' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 120_000 });
    if (await page.getByRole('form', { name: 'Switch on' }).count() > 0) {
      const form = page.getByRole('form', { name: 'Switch on' });
      await form.getByRole('combobox', { name: /Reason/ }).click();
      await page.getByRole('option').first().click();
      await form.getByRole('button', { name: 'Yes, switch it on' }).click();
      await expect(page.getByText('Invoicing in parts is switched on.')).toBeVisible({ timeout: 30_000 });
    }

    // The order is found in Sales invoices; its lines show what is invoiced and left.
    await gotoAdmin(page, '/admin/sales-invoices', 'Sales invoices');
    await pick(page, page.getByRole('combobox', { name: 'Order to invoice' }), orderNumber);
    const panel = page.getByTestId('part-invoice-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const line = panel.getByTestId('part-line').first();
    await expect(line).toContainText('ordered 2');

    // Part one: a single unit.
    await panel.getByLabel(/Quantity of .* to invoice/).fill('1');
    await expect(panel.getByTestId('part-preview')).toContainText('This invoice', { timeout: 30_000 });
    await panel.getByRole('button', { name: 'Invoice these quantities' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Part invoice .* raised/ })).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('part-invoice')).toHaveCount(1, { timeout: 30_000 });
    await expect(line).toContainText('invoiced 1');
    await expect(line).toContainText('left 1');

    // More than is left is refused in words, on the preview, before anything is raised.
    await panel.getByLabel(/Quantity of .* to invoice/).fill('5');
    await expect(panel.getByTestId('part-preview-problem')).toContainText('at most', { timeout: 30_000 });
    await expect(panel.getByRole('button', { name: 'Invoice these quantities' })).toBeDisabled();

    // Part two: what is left finishes the order.
    await panel.getByRole('button', { name: 'Invoice what is left' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'the order is now invoiced in full' })).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('part-invoice')).toHaveCount(2, { timeout: 30_000 });
    await expect(panel.getByTestId('part-invoice').nth(1)).toContainText('finishes the order');
    await expect(panel.getByTestId('part-invoice-reason')).toContainText('invoiced in full');
    await expect(panel.getByRole('button', { name: 'Invoice what is left' })).toHaveCount(0);

    // Both are in the invoice list as part invoices, each with its own number.
    await expect(async () => {
      await page.locator('label').filter({ hasText: /^Part invoices$/ }).click();
      await expect(page.getByTestId('sales-invoice').filter({ hasText: orderNumber }).first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 90_000 });
    await expect(page.getByTestId('sales-invoice').filter({ hasText: orderNumber })).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('sales-invoice').filter({ hasText: orderNumber }).first()).toContainText('Part invoice');
    await noHorizontalScroll(page);
  });
});
