import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor } from './support/vendors';

test.describe('goods sent back to a vendor', () => {
  test('are written from a received goods note, posted by another person, and listed', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const note = invoiceTool('return-note', po.poId ?? '');

    await open(page, `/admin/vendors/receipts/${note.rgnId ?? ''}`, /^RGN-/);
    await page.getByRole('link', { name: /Send goods back to the vendor/ }).click();
    await expect(page.getByRole('heading', { name: 'Send goods back', level: 2 })).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const form = page.getByRole('form', { name: 'Return of goods' });
    await pick(page, form.getByRole('combobox', { name: 'Why' }), 'faulty', /Found faulty/);
    await form.getByLabel(/^Quantity of /).first().fill('1');
    await form.getByRole('button', { name: 'Save the return' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Return \(not posted yet\)/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You wrote this return, so another person has to post it.')).toBeVisible();
    await noHorizontalScroll(page);
    const returnId = /returns\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    invoiceTool('return-post', returnId);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Return PRT-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await open(page, '/admin/vendors/returns', 'Goods sent back to vendors');
    await expect(page.getByRole('list', { name: 'Returns' }).getByText(/PRT-\d{4}-\d{5}/).first()).toBeVisible({ timeout: 60_000 });
  });
});
