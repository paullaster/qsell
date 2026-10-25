import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, invoiceTool } from './support/vendors';

test.describe('petty cash', () => {
  test('a voucher is written, needs a receipt, is approved by another person, paid out of the float, and a top-up brings the float back up', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    invoiceTool('prepare');
    invoiceTool('payments-prepare');
    const made = invoiceTool('petty-float', tag);
    const floatId = made.floatId ?? '';

    await open(page, '/admin/vendors/petty-cash', 'Petty cash');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(page.getByText(made.name ?? '').first()).toBeVisible({ timeout: 60_000 });

    await open(page, `/admin/vendors/petty-cash/vouchers/new?float=${floatId}`, 'New petty cash voucher');
    await page.getByLabel('Who is paid').fill('Corner shop');
    await page.getByLabel('Amount', { exact: true }).fill('250');
    await page.getByLabel('What it is for').fill('Tea and sugar for the office');
    await page.getByLabel('Number on the receipt').fill(`R-${tag}`);
    await pick(page, page.getByRole('combobox', { name: 'Booked to the expense' }), '6200', /^6200/);
    await page.getByRole('button', { name: 'Save as a draft' }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Petty cash \(not numbered yet\)/, level: 2 })).toBeVisible({ timeout: 60_000 });
    const voucherId = /vouchers\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    // Without a receipt it cannot be sent.
    await clickUntilVisible(page.getByRole('button', { name: 'Send for approval' }), page.getByText('Attach a picture of the receipt first.').first());
    invoiceTool('petty-receipt', voucherId);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Receipt pictures' }).getByText('receipt.jpg')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Send for approval' }).dispatchEvent('click');
    await expect(page.getByText('Waiting for approval').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('You wrote this voucher, so another person has to approve it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    invoiceTool('petty-approve', voucherId);
    await page.reload();
    await page.getByRole('button', { name: 'Record the cash as paid out' }).dispatchEvent('click');
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /^Petty cash PCV-\d{4}-\d{5}/, level: 2 })).toBeVisible();

    await open(page, `/admin/vendors/petty-cash/${floatId}`, /^Front office/);
    await expect(page.getByText('9750.00 KES')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('250.00 of 3000.00')).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Ask for a top-up' }).dispatchEvent('click');
    const ask = page.getByRole('form', { name: 'Ask for a top-up' });
    await pick(page, ask.getByRole('combobox', { name: 'Where the money comes from' }), 'E2E Cash', /^E2E Cash/);
    await ask.getByRole('button', { name: 'Ask for the top-up' }).dispatchEvent('click');
    await expect(page.getByRole('list', { name: 'Top-up requests' }).getByText(/PCR-\d{4}-\d{5} · 250\.00/)).toBeVisible({ timeout: 60_000 });
    invoiceTool('petty-approve-topup', floatId);
    await page.reload();
    const list = page.getByRole('list', { name: 'Top-up requests' });
    await list.getByLabel('Reference of the transfer or withdrawal').fill(`WD-${tag}`);
    await list.getByRole('button', { name: 'Record it as paid' }).dispatchEvent('click');
    await expect(page.getByText('10000.00 KES').first()).toBeVisible({ timeout: 60_000 });
  });
});
