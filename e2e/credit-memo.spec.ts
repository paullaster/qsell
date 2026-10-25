import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { attemptTag, invoiceTool, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };

test.describe('credit notes from vendors', () => {
  test('the vendor credits part of a booked invoice, staff check it, another person approves it, it is booked, and the invoice owes less', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const booked = invoiceTool('book', `${tag}:${vendor.vendorId}:${po.poId ?? ''}:${po.deliveryNote ?? ''}`);
    const creditNo = `CN-${tag}`;
    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto('/vendor/credits/new');
      await expect(w.page.getByRole('heading', { name: 'New credit note', level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => w.page.getByLabel('Your credit note number').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
      await w.page.getByLabel('Your credit note number').fill(creditNo);
      await w.page.getByRole('button', { name: `Credit invoice ${booked.vendorInvoiceNo ?? ''}` }).dispatchEvent('click');
      await expect(w.page.getByRole('heading', { name: `Credit note ${creditNo}`, level: 2 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(w.page);
      await w.page.getByLabel('Why are you crediting this invoice?').fill('Billed 1 unit more than was delivered');
      await w.page.getByLabel(/^Credit line 1:/).check();
      await w.page.getByLabel(/^Quantity to credit/).fill('1');
      await w.page.getByLabel('Choose the file').setInputFiles({ name: 'credit.pdf', ...PDF });
      await expect(w.page.getByRole('link', { name: 'credit.pdf' })).toBeVisible({ timeout: 30_000 });
      await expect(w.page.getByText(/Credit total: 116\.00/)).toBeVisible();
      await w.page.getByRole('button', { name: 'Send credit note' }).dispatchEvent('click');
      await expect(w.page.getByText('Submitted', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByRole('button', { name: `Take back credit note ${creditNo}` })).toBeVisible();

      await open(page, '/admin/vendors/credit-memos', 'Credit memos');
      await noNativeSelect(page);
      await page.getByRole('link', { name: new RegExp(`Their number ${creditNo}`) }).click();
      await expect(page.getByRole('heading', { name: /^Credit memo VCM-\d{4}-\d{5} from /, level: 2 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(page);
      await expect(page.getByText(/Credits 1\.000 .* at 100\.00/)).toBeVisible();
      await page.getByRole('button', { name: 'Pick up this credit memo' }).dispatchEvent('click');
      await expect(page.getByText('You picked this credit memo up, so another person has to approve it.')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

      await w.page.reload();
      await expect(w.page.getByRole('button', { name: `Take back credit note ${creditNo}` })).toHaveCount(0);

      invoiceTool('approve-credit', creditNo);
      await page.reload();
      await page.getByRole('button', { name: 'Book this credit memo' }).dispatchEvent('click');
      await expect(page.getByText(/Booked on /)).toBeVisible({ timeout: 60_000 });

      await open(page, `/admin/vendors/payables/${vendor.vendorId}`, /^Statement:/);
      await expect(page.getByText(/Credit memo VCM-/).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('open 348.00').first()).toBeVisible();

      await w.page.reload();
      await expect(w.page.getByText('Booked', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    } finally {
      await w.close();
    }
  });
});
