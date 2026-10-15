import { expect, test, type Page } from '@playwright/test';
import { pick } from './support/quotes';
import { open, noHorizontalScroll } from './support/page';

/** Says which column is which, choosing each from the file's own headings. */
async function chooseColumns(page: Page): Promise<void> {
  await pick(page, page.getByRole('combobox', { name: 'Date', exact: true }), 'Date', /^Date$/);
  await pick(page, page.getByRole('combobox', { name: 'Description', exact: true }), 'Details', /^Details$/);
  await pick(page, page.getByRole('combobox', { name: 'Money in (credit)' }), 'Paid', /^Paid In$/);
  await pick(page, page.getByRole('combobox', { name: 'Money out (debit)' }), 'Withdr', /^Withdrawn$/);
}

test.describe('bank accounts', () => {
  test('an account is added with pickers for its kind and its fee account', async ({ page }, testInfo) => {
    await open(page, '/admin/finance/bank-accounts', 'Bank and cash accounts');
    await expect(page.getByText('E2E Bank').first()).toBeVisible();
    await page.getByRole('button', { name: 'Add account' }).click();
    const form = page.getByRole('form', { name: 'Add a bank account' });
    await expect(form).toBeVisible();
    await form.getByLabel('Code').fill(`E2E-${testInfo.project.name.toUpperCase()}`);
    await form.getByLabel('Name').fill(`Float ${testInfo.project.name}`);
    await pick(page, form.getByRole('combobox', { name: 'Kind' }), 'cash', /Cash/);
    const fees = form.getByRole('combobox', { name: 'Fees go to' });
    await fees.click();
    await page.getByRole('option').first().click();
    await expect(fees).not.toHaveValue('');
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Add account' }).click();
    await expect(page.getByText('Bank account added.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`Float ${testInfo.project.name}`).first()).toBeVisible();
  });
});

test.describe('bank statements', () => {
  test('a statement is imported through column pickers and its lines are worked on', async ({ page }, testInfo) => {
    const who = testInfo.project.name;
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Import a statement' }).click();
    const csv = `Date,Details,Paid In,Withdrawn\n2026-10-10,Rent ${who},,1200.00\n2026-10-11,Deposit ${who},300.00,\n`;
    await page.getByLabel(/Statement file/).setInputFiles({ name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('Which column is which')).toBeVisible({ timeout: 30_000 });
    // The columns are chosen from the file's own headings, searched on the server.
    await chooseColumns(page);
    await expect(page.getByRole('combobox', { name: 'Dates are written' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText(/new lines? from/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Import 2 lines/ }).click();
    await expect(page.getByText(/^Imported 2 lines/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).first().click();

    const deposit = page.getByRole('listitem').filter({ hasText: `Deposit ${who}` });
    await expect(deposit).toBeVisible({ timeout: 30_000 });
    await deposit.getByRole('button', { name: 'Set aside' }).click();
    const reason = deposit.getByRole('combobox', { name: 'Reason' });
    await reason.click();
    await page.getByRole('option').first().click();
    await deposit.getByLabel(/^(Explain|Comment)/).fill('not ours to record');
    await deposit.getByRole('button', { name: 'Set aside' }).last().click();
    await expect(page.getByText('Set aside.')).toBeVisible({ timeout: 30_000 });

    const rent = page.getByRole('listitem').filter({ hasText: `Rent ${who}` });
    await rent.getByRole('button', { name: 'Find in our records' }).click();
    await expect(rent.getByRole('group', { name: 'Choose what this line matches' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('a deposit can become a customer’s receipt through pickers', async ({ page }, testInfo) => {
    const who = testInfo.project.name;
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Import a statement' }).click();
    const csv = `Date,Details,Paid In,Withdrawn\n2026-10-12,Paid in ${who},450.00,\n`;
    await page.getByLabel(/Statement file/).setInputFiles({ name: 'statement2.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('Which column is which')).toBeVisible({ timeout: 30_000 });
    await chooseColumns(page);
    await page.getByRole('button', { name: 'Check the file' }).click();
    await page.getByRole('button', { name: /^Import 1 line/ }).click();
    await expect(page.getByText(/^Imported 1 line/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).first().click();

    const line = page.getByRole('listitem').filter({ hasText: `Paid in ${who}` });
    await line.getByRole('button', { name: /customer's payment/ }).click();
    await pick(page, line.getByRole('combobox', { name: 'Customer' }), 'Alice', /Alice Cash/);
    await pick(page, line.getByRole('combobox', { name: 'Paid by' }), 'E2E', /E2E Cash/);
    await line.getByRole('button', { name: 'Create receipt' }).click();
    await expect(page.getByText('Receipt created, posted and matched.')).toBeVisible({ timeout: 30_000 });
  });
});
