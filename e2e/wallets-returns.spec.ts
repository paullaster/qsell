import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, open, noHorizontalScroll } from './support/page';

test.describe('wallets', () => {
  test('the policy is set with pickers and saved', async ({ page }) => {
    await open(page, '/admin/finance/receivables/wallet-policy', 'Wallet policy');
    const form = page.getByRole('form', { name: 'Rules for the whole business' });
    await clickUntilVisible(page.getByRole('button', { name: 'Change', exact: true }).first(), form);
    await form.getByLabel('Customers can hold credit with us').check();
    await pick(page, form.getByRole('combobox', { name: 'Money paid beyond what is owed' }), 'wallet', /Put it in the wallet/);
    await form.getByRole('combobox', { name: 'On a new credit invoice' }).click();
    await expect(page.getByRole('option', { name: 'Pay from the wallet automatically' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Save from today' }).click();
    await expect(page.getByText('Saved. It applies from today.')).toBeVisible({ timeout: 30_000 });
  });

  test('an advance deposit is held in the customer’s wallet', async ({ page }) => {
    await open(page, '/admin/finance/receipts/new', 'New receipt');
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'Alice', /Alice Cash/);
    await pick(page, page.getByRole('combobox', { name: 'Payment method' }), 'E2E', /E2E Cash/);
    await page.getByLabel(/^Amount/).fill('120.00');
    await page.getByLabel(/Advance deposit/).check();
    await page.getByRole('button', { name: 'Save and post' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/receipts\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText(/^Posted/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: /Alice Cash/ }).first().click();
    const wallet = page.getByRole('region', { name: 'Wallet' });
    await expect(wallet).toContainText(/KES [\d,]+\.\d\d/, { timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Pay out as a refund' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('the wallet report lists who holds credit', async ({ page }) => {
    await open(page, '/admin/finance/receivables/wallets', /liability$/);
    await expect(page.getByRole('link', { name: 'Alice Cash' })).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('returns and credit note excess', () => {
  test('the lists open with their empty states and no native select', async ({ page }) => {
    await open(page, '/admin/finance/receivables/returns', 'Returns');
    await expect(page.getByText('No goods are waiting to be confirmed.')).toBeVisible();
    await page.getByRole('button', { name: 'Finished' }).click();
    await expect(page.getByText('Nothing has been finished yet.')).toBeVisible();
    await open(page, '/admin/finance/receivables/credit-note-excess', 'Credit note excess');
    await expect(page.getByText('Every credit note has been settled.')).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });
});
