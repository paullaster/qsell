import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, open } from './support/page';

test.describe('receipts', () => {
  test('the list filters by status through a picker', async ({ page }) => {
    await open(page, '/admin/finance/receipts', 'Customer receipts');
    await expect(page.locator('select')).toHaveCount(0);
    const status = page.getByRole('combobox', { name: 'Status' });
    await pick(page, status, 'Draft', /Draft/);
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(page.getByText('No receipts match.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear Status' }).click();
    await pick(page, status, 'Posted', /Posted/);
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(page.getByRole('link', { name: /^PAY-/ }).first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('a receipt is entered with pickers, saved as a draft and posted', async ({ page }) => {
    await open(page, '/admin/finance/receipts/new', 'New receipt');
    await expect(page.locator('select')).toHaveCount(0);
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'Alice', /Alice Cash/);
    await expect(page.getByText('Cash customer')).toBeVisible();
    await pick(page, page.getByRole('combobox', { name: 'Payment method' }), 'E2E', /E2E Cash/);
    await page.getByLabel(/^Amount/).fill('120.00');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/receipts\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^Receipt /, level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Post receipt' }).click();
    await expect(page.getByText(/^Posted/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('select')).toHaveCount(0);
  });

  test('a posted receipt can be downloaded and printed from the receipt, the list and the customer account; a draft cannot', async ({ page }, testInfo) => {
    test.slow();
    const amount = testInfo.project.name === 'phone' ? '78.00' : '77.00';
    await open(page, '/admin/finance/receipts/new', 'New receipt');
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'Alice', /Alice Cash/);
    await pick(page, page.getByRole('combobox', { name: 'Payment method' }), 'E2E', /E2E Cash/);
    await page.getByLabel(/^Amount/).fill(amount);
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/receipts\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = /receipts\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    await expect(page.getByRole('button', { name: 'Post receipt' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Download receipt/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Print receipt/ })).toHaveCount(0);
    // The server refuses a draft too, not only the screen.
    expect((await page.request.get(`/api/admin/finance/receipts/${id}/pdf`)).status()).toBe(400);

    await page.getByRole('button', { name: 'Post receipt' }).click();
    await expect(page.getByText(/^Posted/).first()).toBeVisible({ timeout: 30_000 });
    const download = page.getByRole('link', { name: /^Download receipt/ });
    await expect(download).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Print receipt/ })).toBeVisible();
    await noHorizontalScroll(page);

    const href = (await download.getAttribute('href')) ?? '';
    const file = await page.request.get(href);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect(file.headers()['content-disposition']).toMatch(/^attachment; filename="Receipt-PAY-.*\.pdf"$/);
    expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await page.request.get(`${href}?inline=1`)).headers()['content-disposition']).toMatch(/^inline;/);
    expect((await page.request.get('/api/admin/finance/receipts/not-an-id/pdf')).status()).toBe(404);

    // The same receipt, from the customer's account.
    await page.getByRole('link', { name: /^Alice Cash/ }).first().click();
    await expect(page.getByRole('link', { name: /^Download receipt PAY-/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Print receipt PAY-/ }).first()).toBeVisible();
  });

  test('the receipts list offers download and print on posted receipts', async ({ page }) => {
    await open(page, '/admin/finance/receipts', 'Customer receipts');
    await expect(page.getByRole('link', { name: /^Download receipt PAY-/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Print receipt PAY-/ }).first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('a draft is cancelled with a reason picked from the list', async ({ page }) => {
    await open(page, '/admin/finance/receipts/new', 'New receipt');
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'Bulk customer 01', /Bulk customer 01/);
    await pick(page, page.getByRole('combobox', { name: 'Payment method' }), 'E2E', /E2E Cash/);
    await page.getByLabel(/^Amount/).fill('15.00');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/receipts\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancel draft' }).click();
    const reason = page.getByRole('combobox', { name: 'Reason' });
    await reason.click();
    await page.getByRole('option').first().click();
    await page.getByLabel(/^(Explain|Comment)/).fill('entered by mistake');
    await page.getByRole('button', { name: 'Cancel the draft' }).click();
    await expect(page.getByText('Draft cancelled.')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('refunds', () => {
  test('the list filters by status through a picker', async ({ page }) => {
    await open(page, '/admin/finance/refunds', 'Refunds');
    await expect(page.locator('select')).toHaveCount(0);
    await clickUntilVisible(page.getByRole('combobox', { name: 'Status' }), page.getByRole('option', { name: 'Waiting for approval' }));
    await noHorizontalScroll(page);
  });

  test('a refund is taken from what the customer is owed and saved as a draft', async ({ page }, testInfo) => {
    // The same amount by the same method within a day is refused as a repeat, so each run asks for its own.
    const amount = testInfo.project.name === 'phone' ? '51.00' : '50.00';
    await open(page, '/admin/finance/refunds/new', 'New refund');
    await expect(page.locator('select')).toHaveCount(0);
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'Alice', /Alice Cash/);
    const from = page.getByRole('combobox', { name: 'Refund from' });
    await from.click();
    await page.getByRole('option').first().click();
    await expect(page.getByLabel(/^Amount/)).not.toHaveValue('');
    await page.getByLabel(/^Amount/).fill(amount);
    await pick(page, page.getByRole('combobox', { name: 'Pay by' }), 'E2E', /E2E Cash/);
    await page.getByLabel('Who will collect the cash').fill('Alice');
    const reason = page.getByRole('combobox', { name: 'Reason' });
    await reason.click();
    await page.getByRole('option').first().click();
    await page.getByLabel(/^(Explain|Comment)/).fill('customer paid twice');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/refunds\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^Refund /, level: 2 })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
  });
});
