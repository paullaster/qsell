import { expect, test, type Page } from '@playwright/test';
import { pick } from './support/quotes';

async function open(page: Page, url: string, heading: string | RegExp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(url);
    try {
      await expect(page.getByRole('heading', { name: heading, level: 2 }).first()).toBeVisible({ timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test.describe('wallets', () => {
  test('the policy is set with pickers and saved', async ({ page }) => {
    await open(page, '/admin/finance/receivables/wallet-policy', 'Wallet policy');
    await page.getByRole('button', { name: 'Change', exact: true }).first().click();
    const form = page.getByRole('form', { name: 'Rules for the whole business' });
    await expect(form).toBeVisible();
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
