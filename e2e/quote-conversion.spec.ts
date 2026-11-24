import { expect, test, type Page } from '@playwright/test';
import { gotoAdmin } from './support/quotes';
import { noHorizontalScroll, noNativeSelect } from './support/page';
import { sentQuoteFor } from './support/quote-fixture';

/** Finds the quote in the list by its number and opens the convert dialog from its row. */
async function openConvert(page: Page, number: string): Promise<void> {
  await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
  await page.getByRole('searchbox', { name: 'Search quotes' }).fill(number);
  await expect(page.getByRole('table').first().locator('tbody tr, ul li').first()).toBeVisible({ timeout: 30_000 });
  const button = page.getByRole('button', { name: new RegExp(`Convert ${number}`) }).first();
  await expect(async () => {
    await button.click();
    await expect(page.getByRole('dialog', { name: `Convert ${number}` })).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('converting a quote', () => {
  test('a sent quote offers four choices, says why one is unavailable, and becomes a sales invoice', async ({ page }, info) => {
    const quote = sentQuoteFor(`${info.project.name}${String(Date.now()).slice(-6)}`, 'credit');
    await openConvert(page, quote.number);
    const dialog = page.getByRole('dialog', { name: `Convert ${quote.number}` });
    await expect(dialog.getByText('What should this quote become?')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(quote.customer)).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(4);
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // The counter needs a shift; the reason is on the card, not hidden.
    await expect(dialog.getByTestId('convert-cash_sale')).toContainText('Cash sale');
    await expect(dialog.getByTestId('convert-cash_sale-why')).toContainText('Open a shift');
    await expect(dialog.getByRole('radio', { name: /Cash sale/ })).toBeDisabled();
    // Nothing is chosen for the person: the button waits.
    await expect(dialog.getByTestId('convert-confirm')).toBeDisabled();
    await expect(dialog.getByTestId('convert-hint')).toBeVisible();

    await dialog.getByTestId('convert-sales_invoice').click();
    await expect(dialog.getByTestId('convert-effects')).toContainText('tax invoice is made now');
    await expect(dialog.getByTestId('convert-confirm')).toHaveText('Issue the sales invoice');
    await noHorizontalScroll(page);
    await dialog.getByTestId('convert-confirm').click();

    const done = page.getByRole('dialog', { name: 'Sales invoice created' });
    await expect(done).toBeVisible({ timeout: 60_000 });
    await expect(done.getByTestId('convert-invoice-number')).toHaveText(/^INV-/);
    await expect(done.getByTestId('convert-order-number')).not.toHaveText('');
    await done.getByTestId('convert-close').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The quote has become the invoice, so it cannot be converted a second time.
    await expect(page.getByText(`${quote.number} was converted.`)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('searchbox', { name: 'Search quotes' }).fill(quote.number);
    await expect(page.getByRole('button', { name: new RegExp(`Convert ${quote.number}`) })).toHaveCount(0, { timeout: 30_000 });
  });

  test('a customer with no credit account cannot be sold to on credit, and the quote still becomes a sales order', async ({ page }, info) => {
    const quote = sentQuoteFor(`${info.project.name}${String(Date.now()).slice(-6)}`, 'cash');
    await openConvert(page, quote.number);
    const dialog = page.getByRole('dialog', { name: `Convert ${quote.number}` });
    await expect(dialog.getByRole('radio')).toHaveCount(4, { timeout: 30_000 });
    await expect(dialog.getByTestId('convert-credit_sale-why')).toContainText('has no credit account');
    await expect(dialog.getByRole('radio', { name: /Credit sale/ })).toBeDisabled();
    await dialog.getByTestId('convert-sales_order').click();
    await expect(dialog.getByTestId('convert-effects')).toContainText('sales order');
    await dialog.getByTestId('convert-confirm').click();
    const done = page.getByRole('dialog', { name: 'Sales order created' });
    await expect(done).toBeVisible({ timeout: 60_000 });
    await expect(done.getByTestId('convert-order-number')).not.toHaveText('');
    await expect(done.getByRole('link', { name: 'Open Sales Orders' })).toHaveAttribute('href', '/admin/sales-orders');
  });
});
