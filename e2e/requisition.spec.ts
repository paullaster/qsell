import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makeRfq, makeVendor } from './support/vendors';

test.describe('purchase requisitions', () => {
  test('are written and sent, approved by another person, and turned into a request for quotation', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makeRfq(tag, [vendor.vendorId], 'category');

    await open(page, '/admin/vendors/requisitions', 'Purchase requisitions');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'New requisition' }).click();
    await expect(page.getByRole('heading', { name: 'New purchase requisition', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('What is it for (a short title)').fill(`Chairs ${tag}`);
    await page.getByLabel('Why it is needed').fill('Eight new hires');
    await pick(page, page.getByRole('combobox', { name: 'Kind of purchase' }), cat.categoryName.slice(-10), new RegExp(cat.categoryName));
    await pick(page, page.getByRole('combobox', { name: 'Currency' }), 'KES', /KES/);
    await page.getByLabel('Item 1').fill('Office chair');
    await page.getByLabel('Quantity 1').fill('8');
    await page.getByLabel('Estimated price each 1').fill('4500');
    await expect(page.getByText(/Estimated total: 36000\.00 KES/)).toBeVisible();
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Requisition PRQ-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You wrote this requisition, so another person has to decide it.')).toBeVisible();
    await noHorizontalScroll(page);
    const id = /requisitions\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    invoiceTool('requisition-approve', id);
    await page.reload();
    const when = new Date(Date.now() + 14 * 86_400_000);
    const two = (n: number) => String(n).padStart(2, '0');
    const convert = page.getByRole('button', { name: 'A request for quotation' });
    await expect(async () => {
      await page.getByLabel('Quotes due by').fill(`${String(when.getFullYear())}-${two(when.getMonth() + 1)}-${two(when.getDate())}T10:00`);
      await expect(convert).toBeEnabled({ timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await convert.dispatchEvent('click');
    await expect(page.getByRole('heading', { name: 'Draft request', level: 2 })).toBeVisible({ timeout: 60_000 });
    await open(page, `/admin/vendors/requisitions/${id}`, /^Requisition PRQ-/);
    await expect(page.getByText(/It became a request for quotation/)).toBeVisible({ timeout: 60_000 });
  });
});
