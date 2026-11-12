import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect } from './support/page';
import { editor, openNewQuote, openQuoteOf, pick, saveQuote } from './support/quotes';
import { makeLunchPackage } from './support/storefront-fixtures';

test.describe('a package on a quote', () => {
  test('staff add a package with the same builder, see the price and the choices on the line, change the choices, save, and open it again', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pq${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLunchPackage(tag);
    const customer = `Lunch Buyer ${tag}`;

    const dialog = await openNewQuote(page);
    await dialog.getByLabel('Customer name').fill(customer);
    await dialog.getByRole('button', { name: 'Add a package' }).click();
    const chooser = page.getByRole('dialog', { name: 'Choose a package' });
    await expect(chooser).toBeVisible();
    await pick(page, chooser.getByRole('combobox', { name: 'Package' }), made.name, new RegExp(made.name));

    // The same builder as the shop; a quote promises nothing from the shelves, so even the part with no stock can be chosen.
    await expect(chooser.getByTestId('package-builder')).toBeVisible({ timeout: 30_000 });
    await expect(chooser.getByRole('radio', { name: new RegExp(made.brown) })).toBeVisible();
    await chooser.getByRole('radio', { name: new RegExp(made.small) }).click();
    await chooser.getByRole('radio', { name: new RegExp(made.brown) }).click();
    await expect(chooser.getByTestId('package-total')).toContainText('680');
    await noNativeSelect(page);
    await chooser.getByRole('button', { name: 'Add to the quote' }).click();
    await expect(chooser).toBeHidden();

    // The line reads as the choices, its price is set by the package, and the totals are the server's.
    const line = dialog.getByRole('row').filter({ hasText: made.name });
    await expect(line).toContainText(made.small, { timeout: 30_000 });
    await expect(line).toContainText('Set by the package');
    await expect(line.getByRole('button', { name: 'Change choices' })).toBeVisible();
    await expect(dialog).toContainText('680', { timeout: 30_000 });

    // Changing the choices reopens the builder on what was chosen.
    await line.getByRole('button', { name: 'Change choices' }).click();
    await expect(chooser.getByRole('radio', { name: new RegExp(made.small) })).toBeChecked({ timeout: 30_000 });
    await chooser.getByRole('radio', { name: new RegExp(made.large) }).click();
    await chooser.getByRole('button', { name: 'Save choices' }).click();
    await expect(line).toContainText(made.large, { timeout: 30_000 });
    await expect(dialog).toContainText('800', { timeout: 30_000 });
    await noHorizontalScroll(page);

    await saveQuote(page, dialog, customer);
    // Opened again, the quote still reads the same and can be changed.
    const again = await openQuoteOf(page, customer);
    const kept = again.getByRole('row').filter({ hasText: made.name });
    await expect(kept).toContainText(made.large, { timeout: 30_000 });
    await expect(kept.getByRole('button', { name: 'Change choices' })).toBeVisible();
    await expect(editor(page)).toBeVisible();
  });
});
