import { expect, test } from '@playwright/test';
import { noHorizontalScroll, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor } from './support/vendors';

test.describe('paying on account', () => {
  test('money paid on account is set against a booked invoice, and the vendor ledger still agrees with the books', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    invoiceTool('payments-prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const booked = invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);

    await open(page, '/admin/vendors/payments/new', 'New payment');
    await pick(page, page.getByRole('combobox', { name: 'Vendor' }), vendor.legalName, new RegExp(vendor.legalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.getByRole('button', { name: 'Payment on account' }).click();
    await page.getByLabel('Amount to pay').fill('300');
    await page.getByLabel('Note (optional)').fill('Deposit for next season');
    await pick(page, page.getByRole('combobox', { name: 'How it will be paid' }), 'E2E Cash', /^E2E Cash/);
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Payment .* to /, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Payment on account').first()).toBeVisible();
    const voucherId = /\/payments\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    invoiceTool('approve-voucher', voucherId);
    await page.reload();
    const form = page.getByRole('form', { name: 'Record the payment' });
    await form.getByLabel('Payment reference').fill(`OA-${tag}`);
    await form.getByRole('button', { name: 'Record the payment' }).dispatchEvent('click');
    await expect(page.getByText(`reference OA-${tag}`)).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/vendors/invoices/${booked.invoiceId ?? ''}`, /^Invoice SINV-/);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Set payments on account against it' }).dispatchEvent('click');
    await expect(page.getByText('Payments on account are set against this invoice: 300.00.')).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/vendors/payables/${vendor.vendorId}`, /^Statement:/);
    await expect(page.getByText('open 164.00').first()).toBeVisible({ timeout: 60_000 });

    await open(page, '/admin/vendors/payables', 'What we owe');
    await page.getByRole('button', { name: 'Check now' }).dispatchEvent('click');
    await expect(page.getByRole('status').filter({ hasText: 'The vendor ledger agrees with the books.' })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
  });
});
