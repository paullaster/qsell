import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor } from './support/vendors';

test.describe('a payment found on the bank statement', () => {
  test('becomes a voucher for the vendor, is approved by another person, and the line is matched when it is recorded', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    invoiceTool('payments-prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);
    const seeded = invoiceTool('statement-line', `${tag}:164.00`);
    const name = new RegExp(vendor.legalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    await open(page, `/admin/finance/bank-statements/${seeded.bankAccountId ?? ''}`, / — /);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const line = page.getByRole('listitem').filter({ hasText: seeded.description ?? '' }).first();
    await expect(line).toBeVisible({ timeout: 60_000 });
    await line.getByRole('button', { name: 'It is a payment to a vendor' }).dispatchEvent('click');
    const form = page.getByRole('form', { name: 'Payment to a vendor' });
    await pick(page, form.getByRole('combobox', { name: 'Vendor' }), vendor.legalName, name);
    await pick(page, form.getByRole('combobox', { name: 'Paid by' }), 'E2E Cash', /^E2E Cash/);
    await form.getByRole('button', { name: 'Write the payment voucher' }).dispatchEvent('click');
    await expect(page.getByText(/Payment voucher written and sent for approval/)).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);

    const approved = invoiceTool('statement-voucher', String(seeded.lineId));
    await open(page, `/admin/vendors/payments/${approved.id ?? ''}`, /^Payment .* to /);
    const pay = page.getByRole('form', { name: 'Record the payment' });
    await pay.getByLabel('Payment reference').fill(`E2E-BANK-${tag}`);
    await pay.getByRole('button', { name: 'Record the payment' }).dispatchEvent('click');
    await expect(page.getByText(`reference E2E-BANK-${tag}`)).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/finance/bank-statements/${seeded.bankAccountId ?? ''}`, / — /);
    await page.getByRole('button', { name: /^Matched \(/ }).dispatchEvent('click');
    const done = page.getByRole('listitem').filter({ hasText: seeded.description ?? '' }).first();
    await expect(done).toBeVisible({ timeout: 60_000 });
    await expect(done.getByText(/Matched to/)).toBeVisible();
  });
});
