import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

/** A vendor with a booked invoice of 464.00 (4 units at 100 plus 16% tax), and a way of paying vendors. */
function bookedInvoice(tag: string) {
  invoiceTool('prepare');
  invoiceTool('payments-prepare');
  const vendor = makeVendor(tag, 'approved');
  const po = makePo(tag, vendor.vendorId, 'received');
  const booked = invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);
  return { vendor, po, purchaseInvoiceId: booked.purchaseInvoiceId ?? '', vendorInvoiceNo: booked.vendorInvoiceNo ?? '' };
}

test.describe('paying vendors', () => {
  test('a voucher is prepared from a booked invoice, approved by another person, paid, and the vendor sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const b = bookedInvoice(tag);
    await open(page, `/admin/vendors/payments/new?invoice=${b.purchaseInvoiceId}`, 'New payment');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(page.getByLabel('Amount to pay')).toHaveValue('464.00', { timeout: 60_000 });
    await pick(page, page.getByRole('combobox', { name: 'How it will be paid' }), 'E2E Cash', /^E2E Cash/);
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Payment .* to /, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Waiting for approval').first()).toBeVisible();
    await expect(page.getByText('You prepared this payment, so another person has to approve it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    const voucherId = /\/payments\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    invoiceTool('approve-voucher', voucherId);
    await page.reload();
    await expect(page.getByText('Approved, to be paid').first()).toBeVisible({ timeout: 60_000 });
    const form = page.getByRole('form', { name: 'Record the payment' });
    await expect(form.getByRole('button', { name: 'Record the payment' })).toBeDisabled();
    await form.getByLabel('Payment reference').fill(`CASH-${tag}`);
    await form.getByRole('button', { name: 'Record the payment' }).dispatchEvent('click');
    await expect(page.getByText(`reference CASH-${tag}`)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse this payment…' })).toBeVisible();

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, b.vendor);
      await w.page.goto('/vendor/payments');
      await expect(w.page.getByText(`Reference CASH-${tag}`)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText(`Invoice ${b.vendorInvoiceNo}: 464.00`)).toBeVisible();
      await noHorizontalScroll(w.page);
    } finally {
      await w.close();
    }
  });

  test('a paid voucher is reversed with a reason, and the invoice shows again in what we owe', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const b = bookedInvoice(tag);
    await open(page, `/admin/vendors/payments/new?invoice=${b.purchaseInvoiceId}`, 'New payment');
    await expect(page.getByLabel('Amount to pay')).toHaveValue('464.00', { timeout: 60_000 });
    await pick(page, page.getByRole('combobox', { name: 'How it will be paid' }), 'E2E Cash', /^E2E Cash/);
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByText('Waiting for approval').first()).toBeVisible({ timeout: 60_000 });
    const voucherId = /\/payments\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    invoiceTool('approve-voucher', voucherId);
    await page.reload();
    const form = page.getByRole('form', { name: 'Record the payment' });
    await form.getByLabel('Payment reference').fill(`REV-${tag}`);
    await form.getByRole('button', { name: 'Record the payment' }).dispatchEvent('click');
    await expect(page.getByRole('button', { name: 'Reverse this payment…' })).toBeVisible({ timeout: 60_000 });

    // Paid in full: the vendor is not in what we owe.
    await open(page, '/admin/vendors/payables', 'What we owe');
    await expect(page.getByText(b.vendor.legalName).locator('visible=true')).toHaveCount(0);

    await open(page, `/admin/vendors/payments/${voucherId}`, /Payment /);
    await page.getByRole('button', { name: 'Reverse this payment…' }).dispatchEvent('click');
    const reverse = page.getByRole('group', { name: 'Reverse the payment' });
    await expect(reverse.getByRole('button', { name: 'Reverse the payment' })).toBeDisabled();
    await reverse.getByLabel('Why is it reversed?').fill('Paid twice by mistake');
    await reverse.getByRole('button', { name: 'Reverse the payment' }).dispatchEvent('click');
    await expect(page.getByText('Reversed: Paid twice by mistake')).toBeVisible({ timeout: 60_000 });

    await open(page, '/admin/vendors/payables', 'What we owe');
    await noHorizontalScroll(page);
    await expect(page.getByText(b.vendor.legalName).locator('visible=true').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('464.00').locator('visible=true').first()).toBeVisible();
  });
});
