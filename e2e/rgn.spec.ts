import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makePo, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('receiving goods', () => {
  test('goods arrive: a refusal needs a reason, the note is posted, the order moves along and the vendor sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'stocked');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, /PO-/);
    await noNativeSelect(page);
    await page.getByRole('link', { name: 'Receive goods…' }).click();
    await expect(page.getByRole('heading', { name: 'New received goods note', level: 2 })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await expect(page.getByText(/Ordered 10\.000 .* received so far 0\.000 · still to come 10/)).toBeVisible();

    await page.getByLabel('Vendor’s delivery note number').fill(`DN-${tag}`);
    await page.getByLabel('Arrived', { exact: true }).fill('10');
    await page.getByLabel('Refused', { exact: true }).fill('2');
    await expect(page.getByText('Accepted: 8')).toBeVisible();
    await page.getByRole('button', { name: 'Post the note' }).click();
    await expect(page.getByText('Say why the goods were refused.')).toBeVisible({ timeout: 30_000 });
    await pick(page, page.getByRole('combobox', { name: 'Why refused' }), 'Damaged', /^Damaged/);
    await page.getByRole('button', { name: 'Post the note' }).click();
    await expect(page.getByText('Posted. The accepted goods are in stock.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /RGN-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Arrived', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Post the note' })).toHaveCount(0);

    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, /PO-/);
    await expect(page.getByText('Partly received').first()).toBeVisible({ timeout: 60_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto(`/vendor/orders/${po.poId ?? ''}`);
      await expect(w.page.getByText(/8\.000 .* accepted, 2\.000 refused \(damaged\)/)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText(`your delivery note DN-${tag}`)).toBeVisible();
    } finally {
      await w.close();
    }
  });

  test('more than ordered is refused, and the same delivery note cannot be received twice', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    await open(page, `/admin/vendors/receipts/new?po=${po.poId ?? ''}`, 'New received goods note');
    await page.getByLabel('Vendor’s delivery note number').fill(`dn-${tag}`);
    await page.getByLabel('Arrived', { exact: true }).fill('6');
    await page.getByRole('button', { name: 'Post the note' }).click();
    await expect(page.getByText(/A note with this delivery note number was already posted/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Vendor’s delivery note number').fill(`DN-other-${tag}`);
    await page.getByLabel('Arrived', { exact: true }).fill('7');
    await page.getByRole('button', { name: 'Post the note' }).click();
    await expect(page.getByText(/only 6 more is allowed on the order/)).toBeVisible({ timeout: 30_000 });
  });

  test('a posted note can be reversed with a reason, and the report shows what is received but not invoiced', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');

    await open(page, '/admin/vendors/receipts/not-invoiced', 'Received, not yet invoiced');
    await expect(page.getByText(po.productName ?? '').locator('visible=true').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/400\.00/).locator('visible=true').first()).toBeVisible();
    await noHorizontalScroll(page);

    await open(page, `/admin/vendors/receipts/${po.rgnId ?? ''}`, /RGN-/);
    await expect(page.getByText('Posted').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Reverse this note…' }).click();
    const form = page.getByRole('form', { name: 'Reverse the note' });
    await form.getByLabel('Why is it reversed?').fill('Wrong delivery');
    await form.getByRole('button', { name: 'Reverse the note' }).click();
    await expect(page.getByText('Reversed. The stock is taken out again.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Reversed: Wrong delivery')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Reverse this note…' })).toHaveCount(0);

    await open(page, '/admin/vendors/receipts/not-invoiced', 'Received, not yet invoiced');
    await expect(page.getByText(po.productName ?? '').locator('visible=true')).toHaveCount(0);
  });
});
