import { expect, test, type Page } from '@playwright/test';
import { gotoAdmin } from './support/quotes';
import { noHorizontalScroll, noNativeSelect } from './support/page';
import { sentQuoteFor } from './support/quote-fixture';

async function openSettings(page: Page): Promise<void> {
  await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
  const dialog = page.getByRole('dialog', { name: 'When a customer accepts a quote' });
  await expect(async () => {
    await page.getByTestId('open-acceptance').click();
    await expect(dialog).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 150_000 });
  await expect(dialog.getByRole('radio')).toHaveCount(4, { timeout: 30_000 });
}

test.describe('what happens when a customer accepts a quote', () => {
  // The first visit to the quotes screen makes the development server compile it, which can take minutes.
  test.setTimeout(420_000);

  test('the choice is saved, says when a text or an alert cannot be sent yet, and is kept', async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog', { name: 'When a customer accepts a quote' });
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // Four plain choices, and the old behaviour (a sales order) until someone chooses.
    await expect(dialog.getByRole('radio', { name: /Make a sales order/ })).toBeChecked();
    await expect(dialog.getByTestId('acceptance-notify')).toContainText('Only tell my staff');
    await expect(dialog.getByTestId('acceptance-credit_sale')).toContainText('credit account');

    // A way of telling staff that cannot work yet says so, where it is switched on.
    await expect(dialog.getByTestId(/-sms-problem$/)).toContainText('No text message provider is connected');
    await expect(dialog.getByTestId(/-push-problem$/)).toContainText('not set up');
    await expect(dialog.getByRole('switch')).toHaveCount(3);

    await dialog.getByTestId('acceptance-notify').click();
    await dialog.getByRole('switch', { name: 'Text message' }).check();
    await dialog.getByTestId('acceptance-save').click();
    await expect(dialog.getByTestId('acceptance-message')).toContainText('Saved');

    // It is kept: opening it again shows the same choice.
    await page.reload();
    await openSettings(page);
    const again = page.getByRole('dialog', { name: 'When a customer accepts a quote' });
    await expect(again.getByRole('radio', { name: /Only tell my staff/ })).toBeChecked();
    await expect(again.getByRole('switch', { name: 'Text message' })).toBeChecked();

    // Put back what the rest of the suite expects.
    await again.getByTestId('acceptance-sales_order').click();
    await again.getByRole('switch', { name: 'Text message' }).uncheck();
    await again.getByTestId('acceptance-save').click();
    await expect(again.getByTestId('acceptance-message')).toContainText('Saved');
  });

  test('when only staff are to be told, the customer is thanked, nothing is made, and staff can convert the quote', async ({ page, browser }, info) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog', { name: 'When a customer accepts a quote' });
    await dialog.getByTestId('acceptance-notify').click();
    await dialog.getByTestId('acceptance-save').click();
    await expect(dialog.getByTestId('acceptance-message')).toContainText('Saved');

    const quote = sentQuoteFor(`${info.project.name}${String(Date.now()).slice(-6)}`, 'credit');
    const customer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const link = await customer.newPage();
    await link.goto(`/quote/${quote.token}`.startsWith('http') ? `/quote/${quote.token}` : `${new URL(page.url()).origin}/quote/${quote.token}`);
    await expect(link.getByRole('heading', { name: quote.number, level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      await link.getByRole('button', { name: 'Accept quote' }).click({ timeout: 3_000 });
      await expect(link.getByTestId('quote-outcome')).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 90_000 });
    await expect(link.getByRole('heading', { name: 'Quote accepted successfully' })).toBeVisible();
    await expect(link.getByTestId('quote-browse')).toHaveAttribute('href', '/');
    await customer.close();

    // Nothing was made: the quote is still waiting for a person, who can convert it and choose.
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await page.getByRole('searchbox', { name: 'Search quotes' }).fill(quote.number);
    const convert = page.getByRole('button', { name: new RegExp(`Convert ${quote.number}`) }).first();
    await expect(convert).toBeVisible({ timeout: 30_000 });

    // Put back what the rest of the suite expects.
    await openSettings(page);
    const restore = page.getByRole('dialog', { name: 'When a customer accepts a quote' });
    await restore.getByTestId('acceptance-sales_order').click();
    await restore.getByTestId('acceptance-save').click();
    await expect(restore.getByTestId('acceptance-message')).toContainText('Saved');
  });
});
