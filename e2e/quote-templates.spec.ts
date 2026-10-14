import { expect, test } from '@playwright/test';
import { openNewQuote, openQuoteOf, pick, saveQuote } from './support/quotes';

test.describe('quote templates and section templates', () => {
  test('a quote is built from a template and a section template, then both are switched', async ({
    page,
  }, info) => {
    const buyer = `Buyer ${info.project.name} ${String(Date.now())}`;
    const dialog = await openNewQuote(page);
    const template = dialog.getByRole('combobox', { name: 'Start from a template' });

    // Start from a template: its two items arrive.
    await pick(page, template, 'Pack 5', 'Pack 5kg');
    await expect(dialog.locator('[id^=quote-line-]')).toHaveCount(2);

    // Add a section made from a section template.
    await dialog.getByRole('button', { name: 'Add section' }).click();
    const sectionPicker = dialog.getByRole('combobox', { name: 'Or from a section template' });
    await pick(page, sectionPicker, 'Baking', 'Baking set');
    await expect(dialog.getByRole('article', { name: 'Section Baking' })).toBeVisible();
    await expect(dialog.locator('[id^=quote-line-]')).toHaveCount(3);

    await saveQuote(page, dialog, buyer);

    // Edit it: switch the quote's template; the Baking section is an addition, so it asks.
    const again = await openQuoteOf(page, buyer);
    const field = again.getByRole('combobox', { name: 'Template', exact: true });
    await expect(field).toHaveValue('Pack 5kg');
    await pick(page, field, 'Pack 10', 'Pack 10kg');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Switch to “Pack 10kg”');
    await expect(ask).toContainText('Section: Baking');

    // Cancel changes nothing.
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(field).toHaveValue('Pack 5kg');
    await expect(again.getByText('Rice 5kg').first()).toBeVisible();

    // Switch, keeping the addition.
    await pick(page, field, 'Pack 10', 'Pack 10kg');
    await ask.getByRole('button', { name: 'Switch template' }).click();
    await expect(again.getByText('Rice 10kg').first()).toBeVisible();
    await expect(again.getByText('Rice 5kg')).toHaveCount(0);
    await expect(again.getByRole('article', { name: 'Section Baking' })).toBeVisible();

    // Switch the Baking section to the Tea set.
    const sectionTemplate = again.getByRole('combobox', { name: 'Template of section Baking' });
    await pick(page, sectionTemplate, 'Tea', 'Tea set');
    await expect(ask).toContainText('Switch section “Baking”');
    await ask.getByRole('button', { name: 'Switch template' }).click();
    await expect(again.getByRole('article', { name: 'Section Tea time' })).toBeVisible();

    await saveQuote(page, again, buyer);
  });

  test('removing an unedited template is applied without asking when nothing was added', async ({
    page,
  }) => {
    const dialog = await openNewQuote(page);
    const template = dialog.getByRole('combobox', { name: 'Start from a template' });
    await pick(page, template, 'Pack 5', 'Pack 5kg');
    await expect(dialog.locator('[id^=quote-line-]')).toHaveCount(2);
    await pick(page, template, 'Pack 10', 'Pack 10kg');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('are replaced');
    await expect(ask).not.toContainText('not in the template');
    await ask.getByRole('button', { name: 'Switch template' }).click();
    await expect(dialog.getByText('Flour 2kg').first()).toBeVisible();
  });
});
