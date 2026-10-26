import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makeRfq, makeVendor } from './support/vendors';

test.describe('vendor contracts', () => {
  test('are written, approved by another person, and an order is called off at the agreed price within the limit', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makeRfq(tag, [vendor.vendorId], 'category');
    const day = (add: number) => new Date(Date.now() + add * 86_400_000).toISOString().slice(0, 10);

    await open(page, '/admin/vendors/contracts', 'Vendor contracts');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'New contract' }).click();
    await expect(page.getByRole('heading', { name: 'New vendor contract', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Title').fill(`Panels ${tag}`);
    await pick(page, page.getByRole('combobox', { name: 'Vendor' }), vendor.legalName, new RegExp(vendor.legalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await pick(page, page.getByRole('combobox', { name: 'Category' }), cat.categoryName.slice(-10), new RegExp(cat.categoryName));
    await pick(page, page.getByRole('combobox', { name: 'Currency' }), 'KES', /KES/);
    await page.getByLabel('Last day').fill(day(365));
    await page.getByLabel('Item 1').fill('Solar panel 450W');
    await page.getByLabel('Agreed price 1').fill('100');
    await page.getByLabel('Most to order 1').fill('10');
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Contract \(draft\)/, level: 2 }).or(page.getByRole('heading', { name: /^Contract /, level: 2 }))).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You wrote this contract, so another person has to approve it.')).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    const id = /contracts\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    invoiceTool('contract-approve', id);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Contract CTR-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    const take = page.getByLabel('Order of Solar panel 450W');
    await expect(async () => {
      await take.fill('11');
      await page.getByRole('button', { name: 'Order from this contract' }).dispatchEvent('click');
      await expect(page.getByText(/only 10 is left on the contract/)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await take.fill('4');
    await page.getByRole('button', { name: 'Order from this contract' }).dispatchEvent('click');
    await expect(page).toHaveURL(/\/admin\/vendors\/orders\/[0-9a-f-]{36}/, { timeout: 60_000 });

    await open(page, `/admin/vendors/contracts/${id}`, /^Contract CTR-/);
    await expect(page.getByText(/ordered 4, 6 left/)).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
  });
});
