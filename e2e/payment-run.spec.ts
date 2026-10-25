import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor } from './support/vendors';

/** A vendor with a booked invoice of 464.00, and the way of paying set up for vendors. */
function booked(tag: string) {
  invoiceTool('prepare');
  invoiceTool('payments-prepare');
  const vendor = makeVendor(tag, 'approved');
  const po = makePo(tag, vendor.vendorId, 'received');
  const b = invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);
  return { vendor, purchaseInvoiceId: b.purchaseInvoiceId ?? '' };
}

test.describe('payment runs', () => {
  test('a run is suggested, made and sent for approval; the maker cannot approve it, another person does; it is released but cannot be confirmed by its releaser', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const b = booked(tag);
    await open(page, '/admin/vendors/payments/runs/new', 'New payment run');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await pick(page, page.getByRole('combobox', { name: 'How it will be paid' }), 'E2E Cash', /^E2E Cash/);
    await page.getByRole('button', { name: 'Suggest payments' }).dispatchEvent('click');
    await expect(page.getByLabel(`Pay ${b.vendor.legalName}`)).toBeChecked({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Make the run' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Payment run VPB-/, level: 2 })).toBeVisible({ timeout: 60_000 });
    const runId = /\/runs\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    await expect(page.getByText('Draft').first()).toBeVisible();
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByText('Waiting for approval').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /^Approve \d+$/ }).dispatchEvent('click');
    await expect(page.getByText('You prepared this payment, so another person has to approve it.')).toBeVisible({ timeout: 60_000 });

    invoiceTool('approve-run', runId);
    await page.reload();
    await expect(page.getByText('Approved, to be released').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Release the run' }).dispatchEvent('click');
    await expect(page.getByText('Released, waiting for the bank').first()).toBeVisible({ timeout: 60_000 });
    const confirm = page.getByRole('form', { name: 'Confirm payment' });
    await confirm.getByLabel('Bank reference').fill(`RUN-${tag}`);
    await confirm.getByRole('button', { name: 'Confirm it was paid' }).dispatchEvent('click');
    await expect(page.getByText('The person who released the run cannot be the one who confirms it was paid.')).toBeVisible({ timeout: 60_000 });
  });

  test('a released run is confirmed by another person and every voucher is paid together', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const b = booked(tag);
    const made = invoiceTool('run', `released:${b.vendor.vendorId}:${b.purchaseInvoiceId}`);
    await open(page, `/admin/vendors/payments/runs/${made.runId ?? ''}`, /Payment run VPB-/);
    await noHorizontalScroll(page);
    await expect(page.getByText('Released, waiting for the bank').first()).toBeVisible({ timeout: 60_000 });
    const confirm = page.getByRole('form', { name: 'Confirm payment' });
    await confirm.getByLabel('Bank reference').fill(`RUN-${tag}`);
    await confirm.getByRole('button', { name: 'Confirm it was paid' }).dispatchEvent('click');
    await expect(page.getByText(`Bank reference RUN-${tag}`, { exact: false })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('form', { name: 'Confirm payment' })).toHaveCount(0);
  });
});
