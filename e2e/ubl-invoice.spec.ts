import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { attemptTag, invoiceTool, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('UBL documents', () => {
  test('a vendor downloads its order as UBL, and starts an invoice from a UBL invoice file', async ({ browser }, testInfo) => {
    test.slow();
    invoiceTool('prepare');
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      const response = await w.page.request.get(`/api/vendor/order-xml/${po.poId ?? ''}`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/xml');
      expect(await response.text()).toContain(`<cbc:ID>${po.number ?? ''}</cbc:ID>`);
      expect((await w.page.request.get('/api/vendor/order-xml/00000000-0000-4000-8000-000000000000')).status()).toBe(404);

      const invoiceNo = `UBL-${tag}`;
      const xml = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>${invoiceNo}</cbc:ID><cbc:IssueDate>${new Date().toISOString().slice(0, 10)}</cbc:IssueDate><cbc:DocumentCurrencyCode>KES</cbc:DocumentCurrencyCode><cac:OrderReference><cbc:ID>${po.number ?? ''}</cbc:ID></cac:OrderReference><cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cac:OrderLineReference><cbc:LineID>1</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>x</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount currencyID="KES">1</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>`;
      await w.page.goto('/vendor/invoices/new');
      await expect(w.page.getByRole('heading', { name: 'New invoice', level: 2 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(w.page);
      await expect.poll(() => w.page.getByLabel('Your invoice number').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
      await w.page.getByLabel('Or start from a UBL 2.1 invoice file').setInputFiles({ name: 'invoice.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
      await expect(w.page.getByRole('heading', { name: `Invoice ${invoiceNo}`, level: 2 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(w.page);
    } finally {
      await w.close();
    }
  });
});
