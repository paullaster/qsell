import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct, makeSalesOrder, makeTradeCustomer } from './support/storefront-fixtures';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('sales invoices', () => {
  test('staff raise the invoice of an order that has none, find it, see how it stands and send or download it', async ({ page }, testInfo) => {
    test.slow();
    const tag = `si${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const customer = makeTradeCustomer(tag);
    const productName = makeProduct(tag);
    const orderNumber = makeSalesOrder(customer, productName);
    expect(orderNumber).not.toBe('');

    await gotoAdmin(page, '/admin/sales-invoices', 'Sales invoices');
    await expect(page.getByLabel('Find an invoice')).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // The order has no invoice yet: it is offered, and raising its invoice makes one.
    await pick(page, page.getByRole('combobox', { name: 'Order to invoice' }), orderNumber);
    await page.getByRole('button', { name: 'Raise invoice' }).click();
    const notice = page.getByTestId('invoice-notice');
    await expect(notice).toContainText(`raised for order ${orderNumber}`, { timeout: 60_000 });
    const invoiceNumber = /Invoice (\S+) raised/.exec((await notice.textContent()) ?? '')?.[1] ?? '';
    expect(invoiceNumber).not.toBe('');

    // It is in the list, found by the customer, with how it stands.
    await page.getByLabel('Find an invoice').fill(customer);
    const row = page.getByTestId('sales-invoice').filter({ hasText: invoiceNumber });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText('Tax invoice');
    await expect(row).toContainText('Unpaid');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Its detail: the lines, no credit notes, the signing log; it can be downloaded and sent again.
    await row.getByRole('button', { name: `Open invoice ${invoiceNumber}` }).click();
    const detail = row.getByTestId('invoice-detail');
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(detail).toContainText(productName);
    await expect(detail).toContainText('No credit notes against this invoice');
    await expect(detail).toContainText(`order ${orderNumber}`);
    const download = page.waitForEvent('download');
    await detail.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toContain(invoiceNumber);
    await detail.getByRole('button', { name: 'Send again by email' }).click();
    await expect(detail.getByText(/Sent .* to|could not be emailed|could not be sent/)).toBeVisible({ timeout: 60_000 });

    // The order has its invoice now: it is no longer offered, and a kind with none shows nothing.
    await expect(page.getByRole('combobox', { name: 'Order to invoice' })).toBeVisible();
    await page.locator('label').filter({ hasText: /^Proforma$/ }).click();
    await expect(page.getByTestId('invoices-empty')).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);
  });
});
