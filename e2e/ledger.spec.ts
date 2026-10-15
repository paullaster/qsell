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

test.describe('the chart of accounts', () => {
  test('is read a page at a time, searched on the server, and an account is added with pickers', async ({ page }, testInfo) => {
    await open(page, '/admin/finance/accounts', 'Chart of accounts');
    // Phones list the accounts as cards, wider screens as a table; either way the first page is there.
    await expect(page.getByText('1120').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByLabel('Search accounts').fill('cash');
    await expect(page.getByText(/cash/i).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search accounts').fill('');

    const number = `9${testInfo.project.name === 'phone' ? '2' : '1'}${String(Date.now()).slice(-5)}`;
    await page.getByRole('button', { name: 'New account' }).click();
    const form = page.getByRole('form', { name: 'New account' });
    await form.getByLabel('Account number').fill(number);
    await form.getByLabel('Name').fill(`E2E ledger ${testInfo.project.name}`);
    await pick(page, form.getByRole('combobox', { name: 'Category' }), 'Expense', /^Expense$/);
    await form.getByRole('combobox', { name: 'Normal balance' }).click();
    await expect(page.getByRole('option', { name: 'Credit' })).toBeVisible();
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Save account' }).click();
    await expect(page.getByText('Account created.')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search accounts').fill(number);
    await expect(page.getByText(`E2E ledger ${testInfo.project.name}`).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('ledger entries, periods and registers', () => {
  test('entries are filtered by an account picked from the server’s list', async ({ page }) => {
    await open(page, '/admin/finance/entries', 'General ledger entries');
    await page.getByRole('combobox', { name: 'Account' }).click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('a fiscal year is created with a shape picker', async ({ page }) => {
    await open(page, '/admin/finance/periods', 'Fiscal years and periods');
    await page.getByRole('button', { name: 'New fiscal year' }).click();
    const shape = page.getByRole('combobox', { name: 'Shape' });
    await expect(shape).toHaveValue('12 calendar months');
    await shape.click();
    await expect(page.getByRole('option', { name: /4-4-5/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('postings and the trial balance open', async ({ page }) => {
    await open(page, '/admin/finance/registers', /Postings/);
    await expect(page.locator('select')).toHaveCount(0);
    await open(page, '/admin/finance/trial-balance', 'Trial balance');
    await expect(page.getByRole('status').filter({ hasText: /balance/i }).first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('journals', () => {
  test('a batch takes lines through an account picker and previews what would be posted', async ({ page }, testInfo) => {
    await open(page, '/admin/finance/journals', 'General journals');
    await page.getByRole('button', { name: 'New batch' }).click();
    const code = `E2E${testInfo.project.name.toUpperCase()}${String(Date.now()).slice(-4)}`;
    await page.getByLabel('Code').fill(code);
    await page.getByLabel('Name').fill('E2E batch');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(code), level: 2 })).toBeVisible({ timeout: 30_000 });

    const add = async (account: string, side: 'Debit' | 'Credit') => {
      await page.getByLabel('Document no.').fill('J-E2E');
      await pick(page, page.getByRole('combobox', { name: 'Account' }), account, new RegExp(account));
      await page.getByLabel(side, { exact: true }).fill('10.00');
      await page.getByRole('button', { name: 'Add line' }).click();
      await expect(page.getByRole('cell', { name: new RegExp(account) }).first()).toBeVisible({ timeout: 30_000 });
    };
    await add('1120', 'Debit');
    await expect(page.getByText('Out of balance')).toBeVisible();
    await add('1130', 'Credit');
    await expect(page.getByText('Out of balance')).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview posting' }).click();
    await expect(page.getByText('Everything in this batch can be posted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Post batch' }).click();
    await expect(page.getByRole('group', { name: 'Confirm posting' })).toBeVisible();
    // Pressed from the keyboard: the phone emulation never reports this button as settled for a pointer click.
    await page.getByRole('button', { name: 'Not yet' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'Confirm posting' })).toBeHidden();
    await noHorizontalScroll(page);
  });
});

test.describe('posting setup and sales posting', () => {
  test('accounts are chosen with pickers', async ({ page }) => {
    await open(page, '/admin/finance/posting-setup', 'Posting setup');
    const edit = page.getByRole('button', { name: /^Edit setup for/ }).first();
    await edit.click();
    const form = page.getByRole('form', { name: 'Edit posting setup' });
    await form.getByRole('combobox', { name: 'Sales', exact: true }).click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);

    await open(page, '/admin/finance/sales-posting', 'Sales posting');
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Account for tax owed on sales' }).click();
    await expect(page.getByRole('option').first().or(page.getByText('No matches'))).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
