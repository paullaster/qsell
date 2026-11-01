import { expect, test } from '@playwright/test';
import { open } from './support/page';

test.describe('company document layouts', () => {
  test('saves configurable quote and invoice headers and footer notes', async ({ page }) => {
    await open(page, '/admin/company/documents', 'Document layouts');
    const form = page.getByRole('form', { name: 'Document layouts' });
    const quoteHeader = form.getByLabel('Header note', { exact: true }).nth(0);
    const quoteFooter = form.getByLabel('Footer note', { exact: true }).nth(0);
    const invoiceHeader = form.getByLabel('Header note', { exact: true }).nth(1);
    const invoiceFooter = form.getByLabel('Footer note', { exact: true }).nth(1);
    const initial = {
      quoteHeader: await quoteHeader.inputValue(),
      quoteFooter: await quoteFooter.inputValue(),
      invoiceHeader: await invoiceHeader.inputValue(),
      invoiceFooter: await invoiceFooter.inputValue(),
      quoteHeaderPosition: await form
        .getByRole('group', { name: 'Quotes header position' })
        .getByRole('button', { name: 'After company details' })
        .getAttribute('aria-pressed'),
      quoteFooterPosition: await form
        .getByRole('group', { name: 'Quotes footer position' })
        .getByRole('button', { name: 'After totals' })
        .getAttribute('aria-pressed'),
    };

    try {
      await quoteHeader.fill('Quote project reference and customer instructions');
      await quoteFooter.fill('Quote-specific footer note');
      await invoiceHeader.fill('Invoice remittance instructions');
      await invoiceFooter.fill('Invoice-specific footer note');
      await form
        .getByRole('group', { name: 'Quotes header position' })
        .getByRole('button', { name: 'After company details' })
        .click();
      await form
        .getByRole('group', { name: 'Quotes footer position' })
        .getByRole('button', { name: 'After totals' })
        .click();
      await form.getByRole('button', { name: 'Save layouts' }).first().click();
      await expect(page.getByText('Document layouts saved.')).toBeVisible({ timeout: 30_000 });

      await page.reload();
      const reloaded = page.getByRole('form', { name: 'Document layouts' });
      await expect(reloaded.getByLabel('Header note', { exact: true }).nth(0)).toHaveValue(
        'Quote project reference and customer instructions',
      );
      await expect(reloaded.getByLabel('Footer note', { exact: true }).nth(0)).toHaveValue(
        'Quote-specific footer note',
      );
      await expect(reloaded.getByLabel('Header note', { exact: true }).nth(1)).toHaveValue(
        'Invoice remittance instructions',
      );
      await expect(reloaded.getByLabel('Footer note', { exact: true }).nth(1)).toHaveValue(
        'Invoice-specific footer note',
      );
      await expect(
        reloaded
          .getByRole('group', { name: 'Quotes header position' })
          .getByRole('button', { name: 'After company details' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        reloaded
          .getByRole('group', { name: 'Quotes footer position' })
          .getByRole('button', { name: 'After totals' }),
      ).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await open(page, '/admin/company/documents', 'Document layouts');
      const restore = page.getByRole('form', { name: 'Document layouts' });
      await restore.getByLabel('Header note', { exact: true }).nth(0).fill(initial.quoteHeader);
      await restore.getByLabel('Footer note', { exact: true }).nth(0).fill(initial.quoteFooter);
      await restore.getByLabel('Header note', { exact: true }).nth(1).fill(initial.invoiceHeader);
      await restore.getByLabel('Footer note', { exact: true }).nth(1).fill(initial.invoiceFooter);
      const quoteHeaderPosition = restore.getByRole('group', { name: 'Quotes header position' });
      const quoteFooterPosition = restore.getByRole('group', { name: 'Quotes footer position' });
      await quoteHeaderPosition
        .getByRole('button', {
          name:
            initial.quoteHeaderPosition === 'true'
              ? 'After company details'
              : 'Before company details',
        })
        .click();
      await quoteFooterPosition
        .getByRole('button', {
          name:
            initial.quoteFooterPosition === 'true'
              ? 'After totals'
              : 'After payment terms and conditions',
        })
        .click();
      await restore.getByRole('button', { name: 'Save layouts' }).first().click();
    }
  });
});
