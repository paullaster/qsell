import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { editor, openNewQuote } from './support/quotes';

/** The product edit window that opens on top of the screen the person was working on. */
const productWindow = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save Changes' }) });

test.describe('the edit-product shortcut on a quote line', () => {
  test('opens the product over the open quote, and a saved price reaches the line without leaving the quote', async ({ page }, testInfo) => {
    const newPrice = testInfo.project.name === 'phone' ? '231' : '217';
    const dialog = await openNewQuote(page);

    // Add Flour 2kg with the quick add, as a person would.
    const quickAdd = dialog.getByRole('combobox', { name: /Quick add to/ });
    await quickAdd.fill('Flour');
    await page.getByRole('option', { name: /Flour 2kg/ }).first().click();
    await dialog.getByRole('button', { name: 'Add', exact: true }).first().click();
    const link = dialog.getByRole('link', { name: 'Edit product Flour 2kg' });
    await expect(link).toBeVisible();

    await expect(async () => {
      await link.click();
      await expect(productWindow(page)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    // The quote is still there underneath, at its own address.
    await expect(page).toHaveURL(/\/admin\/products\/.+quick=1/);
    await expect(editor(page)).toBeVisible();

    const product = productWindow(page);
    await product.getByRole('button', { name: 'Pricing' }).click();
    await product.getByPlaceholder('Leave empty for none').first().fill(newPrice);
    await product.getByRole('button', { name: 'Save Changes' }).click();

    // Back on the quote (not on the product list), the quote kept what was typed and the line shows the new price.
    await expect(productWindow(page)).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/admin\/quotes/);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByRole('spinbutton', { name: /Unit price/i }).first()).toHaveValue(newPrice, { timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
