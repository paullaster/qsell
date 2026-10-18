import { workbook, zip } from '../src/server/domains/finance/domain/xlsx-test-kit';
import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

const daysFromNow = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe('exchange rates', () => {
  test('a rate for a coming day is set with a picker, listed, and removed after asking once', async ({ page }, testInfo) => {
    const phone = testInfo.project.name === 'phone';
    const day = daysFromNow(phone ? 6 : 5);
    await open(page, '/admin/finance/exchange-rates', 'Exchange rates');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Set a rate' });
    await pick(page, form.getByRole('combobox', { name: 'Currency' }), 'US', /USD/);
    await form.getByLabel('Starts on').fill(day);
    await form.getByLabel(/for one unit/).fill('1,5');
    await form.getByRole('button', { name: 'Save rate' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'at most 8 decimals' })).toBeVisible();
    await form.getByLabel(/for one unit/).fill(phone ? '131.25' : '130.5');
    await form.getByLabel('Note (where the rate came from)').fill('central bank mid rate');
    await form.getByRole('button', { name: 'Save rate' }).click();
    await expect(page.getByText(/^Rate saved: 1 USD = /)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);

    const history = page.getByRole('region', { name: 'Rate history' });
    await history.getByRole('button', { name: 'Show', exact: true }).click();
    const row = history.getByRole('listitem').filter({ hasText: day });
    await expect(row).toContainText('central bank mid rate', { timeout: 30_000 });
    await noInnerHorizontalScroll(page);
    await row.getByRole('button', { name: /^Remove the USD rate/ }).click();
    await expect(row.getByRole('button', { name: /^Confirm: / })).toBeVisible();
    await row.getByRole('button', { name: /^Confirm: / }).click();
    await expect(page.getByText('Rate removed.')).toBeVisible({ timeout: 30_000 });
    await expect(history.getByRole('listitem').filter({ hasText: day })).toHaveCount(0);
  });

  test('a past day is refused before it leaves the page', async ({ page }) => {
    await open(page, '/admin/finance/exchange-rates', 'Exchange rates');
    const form = page.getByRole('form', { name: 'Set a rate' });
    await pick(page, form.getByRole('combobox', { name: 'Currency' }), 'US', /USD/);
    await form.getByLabel('Starts on').fill('2020-01-01');
    await form.getByLabel(/for one unit/).fill('100');
    await form.getByRole('button', { name: 'Save rate' }).click();
    // The date field's own minimum stops the save before anything is sent.
    await expect(form.getByLabel('Starts on')).toHaveJSProperty('validity.rangeUnderflow', true);
    await expect(page.getByText(/Rate saved/)).toHaveCount(0);
  });
});

test.describe('stock in the books', () => {
  test('says it is not in the books yet and what stands in the way, on any width', async ({ page }) => {
    await open(page, '/admin/finance/inventory-posting', 'Stock in the books');
    await expect(page.getByText('Not in the books yet')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Readiness' })).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});

test.describe('bank statement rules, feed and file kinds', () => {
  test('the rules and the feed open beside the statement, with pickers and no sideways scrolling', async ({ page }) => {
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await clickUntilVisible(page.getByRole('button', { name: 'Rules and feed' }), page.getByRole('region', { name: 'Matching rules and bank feed' }));
    const panel = page.getByRole('region', { name: 'Matching rules and bank feed' });
    await expect(panel.getByRole('form', { name: 'Matching rules' })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('combobox', { name: 'Our reference quoted on the line' })).toBeVisible();
    await panel.getByLabel('Amount may differ by').fill('-1');
    await panel.getByRole('button', { name: 'Save for this account' }).click();
    await expect(panel.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('group', { name: 'Bank feed' }).or(panel.getByLabel('Bank feed'))).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('a camt.053 file is recognised from its content and imported without choosing columns', async ({ page }, testInfo) => {
    const who = testInfo.project.name;
    const cents = who === 'phone' ? '61.00' : '62.00';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>E2E${who}</MsgId></GrpHdr><Stmt><Id>S1</Id>
<Ntry><Amt Ccy="KES">${cents}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-09</Dt></BookgDt><AcctSvcrRef>E2ECAMT${who}</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Camt ${who}</Nm></Dbtr></RltdPties><RmtInf><Ustrd>camt line ${who}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await clickUntilVisible(page.getByRole('button', { name: 'Import a statement' }), page.getByLabel(/Statement file/));
    // The browser says it is a text file; the content decides.
    await page.getByLabel(/Statement file/).setInputFiles({ name: 'statement.txt', mimeType: 'text/plain', buffer: Buffer.from(xml) });
    await expect(page.getByText('Which column is which')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText(/new lines? from/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Import 1 line/ }).click();
    await expect(page.getByText(/^Imported 1 line/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('listitem').filter({ hasText: `camt line ${who}` })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});

test.describe('Bill Manager invoices list', () => {
  test('is there with its filter picker, nothing to list yet, and no native select', async ({ page }) => {
    await open(page, '/admin/payments/bills', 'Bill Manager invoices');
    const list = page.getByRole('region', { name: 'Invoices' });
    await expect(list.getByRole('heading', { name: /^Invoices \(\d+\)$/ })).toBeVisible();
    await list.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(list.getByText('No invoices match.')).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
  });});

test.describe('bank statement Excel files', () => {
  test('an Excel workbook is read on the server and imported through the column pickers', async ({ page }, testInfo) => {
    const who = testInfo.project.name;
    const text = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
    const sheet = [
      `<row r="1">${text('A1', 'Date')}${text('B1', 'Details')}${text('C1', 'Paid In')}${text('D1', 'Withdrawn')}</row>`,
      `<row r="2">${text('A2', '2026-10-12')}${text('B2', `xlsx line ${who}`)}<c r="C2"><v>${who === 'phone' ? 71 : 72}.5</v></c></row>`,
    ].join('');
    const book = zip(workbook(sheet));
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await clickUntilVisible(page.getByRole('button', { name: 'Import a statement' }), page.getByLabel(/Statement file/));
    await page.getByLabel(/Statement file/).setInputFiles({ name: 'statement.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: book });
    await expect(page.getByText('Which column is which')).toBeVisible({ timeout: 30_000 });
    await pick(page, page.getByRole('combobox', { name: 'Date', exact: true }), 'Date', /^Date$/);
    await pick(page, page.getByRole('combobox', { name: 'Description', exact: true }), 'Details', /^Details$/);
    await pick(page, page.getByRole('combobox', { name: 'Money in (credit)' }), 'Paid', /^Paid In$/);
    await pick(page, page.getByRole('combobox', { name: 'Money out (debit)' }), 'Withdr', /^Withdrawn$/);
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText(/new lines? from/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Import 1 line/ }).click();
    await expect(page.getByText(/^Imported 1 line/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('listitem').filter({ hasText: `xlsx line ${who}` })).toBeVisible({ timeout: 30_000 });
  });
});
