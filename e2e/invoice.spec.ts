import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };

/** The vendor starts an invoice for the order and sends it, with its own invoice and the delivery note attached. */
async function vendorSends(page: Page, invoiceNo: string, orderNumber: string, deliveryNote: string, price = ''): Promise<void> {
  await page.goto('/vendor/invoices/new');
  await expect(page.getByRole('heading', { name: 'New invoice', level: 2 })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel('Your invoice number').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
  await page.getByLabel('Your invoice number').fill(invoiceNo);
  await page.getByRole('button', { name: `Invoice order ${orderNumber}` }).dispatchEvent('click');
  await expect(page.getByRole('heading', { name: `Invoice ${invoiceNo}`, level: 2 })).toBeVisible({ timeout: 60_000 });
  await noHorizontalScroll(page);
  if (price !== '') await page.getByLabel(/^Price per /).fill(price);
  await page.getByLabel('Choose the file').setInputFiles({ name: 'invoice.pdf', ...PDF });
  await expect(page.getByRole('link', { name: 'invoice.pdf' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add a delivery note' }).click();
  await page.getByLabel('Delivery note number').fill(deliveryNote);
  await page.getByLabel('Signed copy').setInputFiles({ name: 'dn.pdf', ...PDF });
  await expect(page.getByRole('link', { name: 'dn.pdf' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('I confirm that this invoice is for goods and services that were delivered.').check();
  await page.getByRole('button', { name: 'Send invoice' }).dispatchEvent('click');
  await expect(page.getByText(/Our number SINV-\d{4}-\d{5}/).first()).toBeVisible({ timeout: 60_000 });
}

test.describe('supplier invoices', () => {
  test('an invoice goes from the vendor to the books: link the goods, check, approve by another person, book', async ({ page, browser }, testInfo) => {
    test.slow();
    invoiceTool('prepare');
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const invoiceNo = `INV-${tag}`;
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await vendorSends(w.page, invoiceNo, po.number ?? '', po.deliveryNote ?? '');
      await expect(w.page.getByText('Submitted', { exact: true }).first()).toBeVisible();
      await expect(w.page.getByRole('button', { name: `Take back invoice ${invoiceNo}` })).toBeVisible();

      await open(page, '/admin/vendors/invoices', 'Supplier invoices');
      await noNativeSelect(page);
      await page.getByRole('link', { name: new RegExp(`Their number ${invoiceNo}`) }).click();
      await expect(page.getByRole('heading', { name: /^Invoice SINV-\d{4}-\d{5} from /, level: 2 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(page);
      await page.getByRole('button', { name: 'Pick up this invoice' }).dispatchEvent('click');
      await page.getByRole('button', { name: 'Link automatically' }).dispatchEvent('click');
      await expect(page.getByRole('button', { name: 'Run the check' })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Run the check' }).dispatchEvent('click');
      await expect(page.getByRole('button', { name: 'Send for approval' })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
      await expect(page.getByText('You linked or checked this invoice, so another person has to approve it.')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

      // The vendor can no longer take it back.
      await w.page.reload();
      await expect(w.page.getByRole('button', { name: `Take back invoice ${invoiceNo}` })).toHaveCount(0);
      await expect(w.page.getByText('We started checking it')).toBeVisible({ timeout: 60_000 });

      invoiceTool('approve', invoiceNo);
      await page.reload();
      await page.getByRole('button', { name: 'Book this invoice' }).dispatchEvent('click');
      await expect(page.getByText(/Booked on /)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Return to the vendor…' })).toHaveCount(0);

      await w.page.reload();
      await expect(w.page.getByText('Booked for payment').first()).toBeVisible({ timeout: 60_000 });
    } finally {
      await w.close();
    }
  });

  test('a vendor takes an untouched invoice back; staff send one back with a reason and the vendor sends it again', async ({ page, browser }, testInfo) => {
    test.slow();
    invoiceTool('prepare');
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const invoiceNo = `INV-${tag}`;
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await vendorSends(w.page, invoiceNo, po.number ?? '', po.deliveryNote ?? '');
      await w.page.getByRole('button', { name: `Take back invoice ${invoiceNo}` }).click();
      await w.page.getByRole('button', { name: `Confirm: Take back invoice ${invoiceNo}` }).click();
      await expect(w.page.getByRole('button', { name: 'Send invoice' })).toBeVisible({ timeout: 60_000 });
      await w.page.getByRole('button', { name: 'Send invoice' }).dispatchEvent('click');
      await expect(w.page.getByText('Submitted', { exact: true }).first()).toBeVisible({ timeout: 60_000 });

      await open(page, '/admin/vendors/invoices', 'Supplier invoices');
      await page.getByRole('link', { name: new RegExp(`Their number ${invoiceNo}`) }).click();
      await expect(page.getByRole('heading', { name: /^Invoice SINV-/, level: 2 })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Pick up this invoice' }).dispatchEvent('click');
      await expect(page.getByRole('button', { name: 'Link automatically' })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Return to the vendor…' }).dispatchEvent('click');
      const panel = page.getByRole('group', { name: 'Return to the vendor' });
      await pick(page, panel.getByRole('combobox', { name: 'Reason' }), 'Prices differ', /^Prices differ/);
      await panel.getByLabel('What does the vendor have to fix?').fill('Use the price on the order');
      await expect(panel.getByRole('button', { name: 'Return it' })).toBeEnabled();
      await panel.getByRole('button', { name: 'Return it' }).dispatchEvent('click');
      await expect(page.getByText(/Returned to the vendor: Prices differ/)).toBeVisible({ timeout: 60_000 });

      await w.page.reload();
      await expect(w.page.getByText('We sent this back: Prices differ from the order')).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByRole('status').getByText('Use the price on the order')).toBeVisible();
      await w.page.getByRole('button', { name: 'Send invoice' }).dispatchEvent('click');
      await expect(w.page.getByText(/Version 2/).first()).toBeVisible({ timeout: 60_000 });
    } finally {
      await w.close();
    }
  });

  test('a price above the order is found by the check and passes only with a reason', async ({ page, browser }, testInfo) => {
    test.slow();
    invoiceTool('prepare');
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const invoiceNo = `INV-${tag}`;
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await vendorSends(w.page, invoiceNo, po.number ?? '', po.deliveryNote ?? '', '140');
      await open(page, '/admin/vendors/invoices', 'Supplier invoices');
      await page.getByRole('link', { name: new RegExp(`Their number ${invoiceNo}`) }).click();
      await expect(page.getByRole('heading', { name: /^Invoice SINV-/, level: 2 })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Pick up this invoice' }).dispatchEvent('click');
      await page.getByRole('button', { name: 'Link automatically' }).dispatchEvent('click');
      await expect(page.getByRole('button', { name: 'Run the check' })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Run the check' }).dispatchEvent('click');
      await expect(page.getByText(/The price is above the order by 160\.00 on this line\./)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Send for approval' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Accept the differences…' }).dispatchEvent('click');
      const panel = page.getByRole('group', { name: 'Accept the differences' });
      await expect(panel.getByRole('button', { name: 'Accept them' })).toBeDisabled();
      await panel.getByLabel('Why are the differences accepted?').fill('Price rise agreed by phone');
      await panel.getByRole('button', { name: 'Accept them' }).dispatchEvent('click');
      await expect(page.getByText(/Differences were accepted .*: Price rise agreed by phone/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Send for approval' })).toBeVisible();
    } finally {
      await w.close();
    }
  });
});
