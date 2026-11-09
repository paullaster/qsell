import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';

test.describe('courier invoices', () => {
  test('an invoice is typed in and matched to the courier\'s charges: short, then agreed, with a charge taken off and the invoice voided', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const courier = `Invoice Couriers ${tag}`;
    deliveryTool('open', tag);
    try {
      deliveryTool('courier-charge', tag, `${courier}|300`);
      deliveryTool('courier-charge', tag, `${courier}|200.50`);

      await open(page, '/admin/delivery/courier-invoices', 'Courier invoices');
      await noNativeSelect(page);
      // The charges are kept but are on no invoice yet.
      await expect(page.getByRole('region', { name: 'Not on an invoice' })).toContainText(courier, { timeout: 30_000 });
      await expect(page.getByRole('region', { name: 'Not on an invoice' })).toContainText('2 charges · KES 500.50');

      // The form needs everything before it can be saved, and says why an invoice is refused.
      const form = page.getByRole('form', { name: 'Type in an invoice' });
      await expect(form.getByRole('button', { name: 'Record the invoice' })).toBeDisabled();
      await pick(page, form.getByRole('combobox', { name: 'Courier' }), courier, new RegExp(courier));
      await form.getByLabel('Invoice number').fill(`INV-${tag}`);
      await form.getByLabel('Day on the invoice').fill('2099-01-01');
      await form.getByLabel('Invoice total (KSh)').fill('600');
      await form.getByRole('button', { name: 'Record the invoice' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'cannot be in the future' })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('Day on the invoice').fill('2026-01-15');
      await form.getByRole('button', { name: 'Record the invoice' }).click();
      await expect(page.getByText('The invoice is recorded. Match its charges below.')).toBeVisible({ timeout: 30_000 });
      await expect(form.getByLabel('Invoice number')).toHaveValue('');

      const list = page.getByRole('list', { name: 'Invoice list' });
      const card = list.getByRole('listitem').filter({ hasText: `INV-${tag}` }).first();
      await expect(card).toContainText('Nothing matched yet', { timeout: 30_000 });
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // Match one charge: we have fewer charges than the invoice.
      await card.getByRole('button', { name: `Match charges to INV-${tag}` }).click();
      const picks = card.getByRole('region', { name: 'Charges that could go on this invoice' });
      await expect(picks).toContainText('KES 300.00', { timeout: 30_000 });
      await picks.getByRole('checkbox').first().check();
      await picks.getByRole('button', { name: /^Match 1 charge/ }).click();
      await expect(page.getByText('The charges are matched.')).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('We have fewer charges than the invoice', { timeout: 30_000 });

      // Match the other: 500.50 against 600.00 is still short, by 99.50.
      const more = card.getByRole('region', { name: 'Charges that could go on this invoice' });
      await more.getByRole('checkbox').first().check();
      await more.getByRole('button', { name: /^Match 1 charge/ }).click();
      await expect(card).toContainText('-99.50', { timeout: 30_000 });
      await expect(card.getByRole('region', { name: 'Charges on this invoice' })).toContainText('KES 300.00');
      await expect(page.getByRole('region', { name: 'Not on an invoice' })).not.toContainText(courier);

      // One charge is taken off; it goes back to the charges on no invoice.
      const on = card.getByRole('region', { name: 'Charges on this invoice' });
      await on.getByRole('listitem').filter({ hasText: '200.50' }).getByRole('button', { name: /^Take off/ }).click();
      await on.getByRole('button', { name: /^Confirm: Take off/ }).click();
      await expect(page.getByText('The charge is taken off the invoice.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('region', { name: 'Not on an invoice' })).toContainText('1 charge · KES 200.50', { timeout: 30_000 });
      await noHorizontalScroll(page);

      // Voided with a reason: the invoice stays on the list, marked, and its charges are free.
      await card.getByLabel('Why it is being voided').fill('Typed against the wrong courier');
      await card.getByRole('button', { name: `Void invoice INV-${tag}` }).click();
      await card.getByRole('button', { name: /^Confirm: Void invoice/ }).click();
      await expect(card).toContainText('Voided', { timeout: 30_000 });
      await expect(card).toContainText('Typed against the wrong courier');
      await expect(page.getByRole('region', { name: 'Not on an invoice' })).toContainText('2 charges · KES 500.50', { timeout: 30_000 });
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
