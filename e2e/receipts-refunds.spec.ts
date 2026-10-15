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
