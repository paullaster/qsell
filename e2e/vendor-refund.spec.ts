import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makeVendor } from './support/vendors';

test.describe('refunds from vendors', () => {
  test('a refund is asked for, booked by another person, and reversed with a reason', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    invoiceTool('payments-prepare');
    const vendor = makeVendor(tag, 'approved');
    invoiceTool('refund-credit', vendor.vendorId);
    const name = new RegExp(vendor.legalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    await open(page, '/admin/vendors/refunds', 'Refunds from vendors');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'New refund' }).dispatchEvent('click');
    const form = page.getByRole('form', { name: 'New refund' });
    await pick(page, form.getByRole('combobox', { name: 'Vendor' }), vendor.legalName, name);
    await form.getByRole('radio', { name: /Payment on account .* open 300.00 KES/ }).check();
    await pick(page, form.getByRole('combobox', { name: 'Money came in by' }), 'E2E Cash', /^E2E Cash/);
    await form.getByLabel('Amount').fill('120');
    await form.getByRole('button', { name: 'Ask for the refund to be booked' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Refund \(not booked yet\)/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You asked for this refund, so another person has to book it.')).toBeVisible();
    await noHorizontalScroll(page);
    const refundId = /refunds\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    invoiceTool('refund-post', refundId);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Refund VRF-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Reference E2E-RF-/)).toBeVisible();
    await page.getByLabel('Why is it reversed?').fill('The transfer bounced');
    await page.getByRole('button', { name: 'Reverse the refund' }).dispatchEvent('click');
    await expect(page.getByText('Reversed: The transfer bounced')).toBeVisible({ timeout: 60_000 });
    await open(page, '/admin/vendors/refunds', 'Refunds from vendors');
    await expect(page.getByRole('list', { name: 'Refunds' }).getByText(/120\.00 KES/).first()).toBeVisible({ timeout: 60_000 });
  });
});
