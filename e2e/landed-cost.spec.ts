import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool, makePo, makeVendor } from './support/vendors';

test.describe('landed costs', () => {
  test('a charge is entered against a received goods note, posted by another person, and raises what the goods cost', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'received');
    const note = invoiceTool('return-note', po.poId ?? '');

    await open(page, `/admin/vendors/receipts/${note.rgnId ?? ''}`, /^RGN-/);
    await page.getByRole('link', { name: /Add a freight, duty or other charge/ }).click();
    await expect(page.getByRole('heading', { name: 'Add a charge to goods', level: 2 })).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const form = page.getByRole('form', { name: 'Landed cost' });
    await pick(page, form.getByRole('combobox', { name: 'Kind of charge' }), 'Freight', /^Freight/);
    await form.getByLabel('What it is').fill('Sea freight');
    await form.getByLabel('Number of the invoice or document').fill(`FR-${tag}`);
    await form.getByLabel('Amount').fill('500');
    await expect(page.getByRole('list', { name: 'How it would be spread' }).getByText('500.00').first()).toBeVisible({ timeout: 60_000 });
    await form.getByRole('button', { name: 'Save the charge' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Landed cost \(not posted yet\)/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You entered this charge, so another person has to post it.')).toBeVisible();
    await noHorizontalScroll(page);
    const id = /landed-costs\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    invoiceTool('landed-post', id);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Landed cost LCA-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('list', { name: 'How it is spread' }).getByText(/cost .* → /).first()).toBeVisible();
    await open(page, '/admin/vendors/landed-costs', 'Landed costs');
    await expect(page.getByRole('list', { name: 'Landed costs' }).getByText(/LCA-\d{4}-\d{5}/).first()).toBeVisible({ timeout: 60_000 });
  });
});
