import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('withholding tax', () => {
  test('a code and the accounts are set, a vendor is given the code, the voucher shows what it settles, and the vendor gets its remittance and certificate', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    invoiceTool('payments-prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const booked = invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);
    const code = `E${tag}`;

    await open(page, '/admin/vendors/payment-rules', 'Payment rules');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Add a code' }).dispatchEvent('click');
    const codeForm = page.getByRole('form', { name: 'Withholding code' });
    await codeForm.getByLabel('Code', { exact: true }).fill(code);
    await codeForm.getByLabel('Name').fill('E2E withholding');
    await codeForm.getByLabel('Rate (%)').fill('5');
    await codeForm.getByRole('button', { name: 'Save the code' }).dispatchEvent('click');
    await expect(page.getByRole('list', { name: 'Codes' }).getByText(code)).toBeVisible({ timeout: 60_000 });
    const accounts = page.getByRole('form', { name: 'Payment accounts' });
    await pick(page, accounts.getByRole('combobox', { name: 'Tax withheld (payable to the tax authority)' }), '2320', /^2320/);
    await accounts.getByRole('button', { name: 'Save' }).dispatchEvent('click');
    await expect(accounts.getByText('Saved.')).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/vendors/${vendor.vendorId}`, vendor.legalName);
    const terms = page.getByRole('form', { name: 'How this vendor is paid' });
    await pick(page, terms.getByRole('combobox', { name: 'Tax withheld from payments' }), code, new RegExp(`^${code}`));
    await terms.getByRole('button', { name: 'Save' }).dispatchEvent('click');
    await expect(terms.getByText('Saved. It applies to payments approved from now on.')).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/vendors/payments/new?invoice=${booked.purchaseInvoiceId ?? ''}`, 'New payment');
    await expect(page.getByLabel('Amount to pay')).toHaveValue('464.00', { timeout: 60_000 });
    await pick(page, page.getByRole('combobox', { name: 'How it will be paid' }), 'E2E Cash', /^E2E Cash/);
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Payment .* to /, level: 2 })).toBeVisible({ timeout: 60_000 });
    const settles = page.getByLabel('What this payment settles');
    await expect(settles).toContainText('20.00');
    await expect(settles).toContainText('444.00');
    const voucherId = /\/payments\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    invoiceTool('approve-voucher', voucherId);
    await page.reload();
    const form = page.getByRole('form', { name: 'Record the payment' });
    await form.getByLabel('Payment reference').fill(`WHT-${tag}`);
    await form.getByRole('button', { name: 'Record the payment' }).dispatchEvent('click');
    await expect(page.getByText(`reference WHT-${tag}`)).toBeVisible({ timeout: 60_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto('/vendor/payments');
      await expect(w.page.getByText(/less tax withheld 20\.00/)).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(w.page);
      await w.page.getByRole('link', { name: 'Certificate', exact: true }).first().dispatchEvent('click');
      await expect(w.page.getByRole('heading', { name: /^Withholding tax certificate WHC-/, level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByLabel('Certificate')).toContainText('20.00');
      await noHorizontalScroll(w.page);
    } finally {
      await w.close();
    }

    await open(page, '/admin/vendors/certificates', 'Withholding tax certificates');
    await expect(page.getByText(vendor.legalName, { exact: false }).locator('visible=true').first()).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
  });
});
