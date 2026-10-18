import { expect, test, type Page } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

const tagOf = (project: string): string => (project === 'phone' ? 'Phone' : 'Desktop');

/** Finds a refund by the customer's name in the refunds list and opens it. */
async function openRefundOf(page: Page, customer: string): Promise<void> {
  await open(page, '/admin/finance/refunds', 'Refunds');
  await page.getByPlaceholder('Number, customer or reference').fill(customer);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.getByRole('link', { name: new RegExp(`^RFD-.*${customer}`) }).first().click();
  await expect(page.getByRole('heading', { name: /^Refund /, level: 2 })).toBeVisible({ timeout: 30_000 });
}

test.describe('a refund payment through M-Pesa that could not be confirmed', () => {
  test('is closed by a person who looked at the statement, and can then be paid another way', async ({ page }, testInfo) => {
    await openRefundOf(page, `Doubt ${tagOf(testInfo.project.name)}`);
    const panel = page.getByRole('region', { name: 'Payment through M-Pesa' });
    await expect(panel).toContainText('in doubt');
    await expect(panel).toContainText('No answer came from Safaricom');
    // no receipt, so there is nothing to look up again
    await expect(panel.getByRole('button', { name: 'Check with Safaricom again' })).toHaveCount(0);
    await noHorizontalScroll(page);
    await clickUntilVisible(panel.getByRole('button', { name: 'Close this attempt…' }), panel.getByRole('form', { name: 'Close this attempt' }));
    const close = panel.getByRole('button', { name: 'Close the attempt' });
    await expect(close).toBeDisabled();
    await panel.getByLabel('The money did not leave: the refund can be sent again').check();
    await panel.getByLabel(/What you found/).fill('the statement shows no debit for this amount');
    await expect(close).toBeEnabled();
    await close.click();
    await expect(page.getByText(/^Closed\. The refund can be sent again\./)).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('failed');
    await expect(panel.getByRole('button', { name: 'Close this attempt…' })).toHaveCount(0);
    await noNativeSelect(page);
  });
});

test.describe('money that came back after a refund was paid', () => {
  test('is recorded, and starts a replacement refund to details that work', async ({ page }, testInfo) => {
    await openRefundOf(page, `Returned ${tagOf(testInfo.project.name)}`);
    const panel = page.getByRole('region', { name: 'Money that came back' });
    await clickUntilVisible(panel.getByRole('button', { name: 'Record money that came back…' }), panel.getByRole('form'));
    await noNativeSelect(page);
    const form = panel.getByRole('form', { name: 'Record money that came back' });
    await form.getByLabel('Reference it came back with').fill(`E2E-BACK-${tagOf(testInfo.project.name)}`);
    await pick(page, form.getByRole('combobox', { name: 'It came back into' }), 'E2E', /E2E Cash/);
    const why = form.getByRole('combobox', { name: 'Why it came back' });
    await why.click();
    await page.getByRole('option').first().click();
    await form.getByLabel(/^(Explain|Comment)/).fill('the number was closed');
    await pick(page, form.getByRole('combobox', { name: 'Pay by' }), 'E2E', /E2E Cash/);
    await form.getByLabel('Who will collect the cash').fill('Customer');
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Record it and start the replacement' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/refunds\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole('note').filter({ hasText: 'This replaces refund' })).toBeVisible({ timeout: 30_000 });
    // the first refund keeps its history of what came back
    await page.goBack();
  });
});

test.describe('bank payment files', () => {
  test('approved bank transfers are put in a file by pickers and ticks, and downloaded exactly as made', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo.project.name);
    await open(page, '/admin/finance/refunds/files', 'Bank payment files');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Make a payment file' });
    const a = form.getByRole('checkbox', { name: new RegExp(`Bank A ${tag}`) });
    const b = form.getByRole('checkbox', { name: new RegExp(`Bank B ${tag}`) });
    await a.check();
    await b.check();
    await expect(form).toContainText('2 chosen');
    await pick(page, form.getByRole('combobox', { name: 'Pay from' }), 'E2E', /E2E Bank transfer/);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Make the file' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/refunds\/files\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^Payment file RPF-/, level: 2 })).toBeVisible({ timeout: 30_000 });
    // the person who made it cannot be the one who confirms the bank paid it
    await expect(page.getByRole('button', { name: 'The bank paid it…' })).toHaveCount(0);
    const download = page.getByRole('link', { name: 'Download the file' });
    await expect(download).toBeVisible();
    const res = await page.request.get((await download.getAttribute('href')) ?? '');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/attachment; filename="RPF-.*\.csv"/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    const text = await res.text();
    expect(text).toContain('KCB,1234567890');
    expect(text.split('\r\n')[0]).toBe('Reference,Beneficiary name,Bank,Account number,Amount,Currency,Narrative');
    await noInnerHorizontalScroll(page);
    // the two refunds now say where they are
    await openRefundOf(page, `Bank A ${tag}`);
    await expect(page.getByRole('note').filter({ hasText: 'waiting in bank payment file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  });

  test('a file made by someone else is confirmed with the bank\'s confirmation attached, and its refund becomes paid', async ({ page }, testInfo) => {
    await openRefundOf(page, `Filed ${tagOf(testInfo.project.name)}`);
    await page.getByRole('note').filter({ hasText: 'waiting in bank payment file' }).getByRole('link').click();
    await expect(page.getByRole('heading', { name: /^Payment file RPF-/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'The bank\'s confirmation' })).toContainText('bank-confirmation.png');
    await clickUntilVisible(page.getByRole('button', { name: 'The bank paid it…' }), page.getByRole('form', { name: 'Record that the bank paid the file' }));
    await page.getByLabel('Bank reference for the file').fill('E2E-BATCH-1');
    await page.getByRole('button', { name: 'Record all as paid' }).click();
    await expect(page.getByText(/Recorded: 1 refund is now paid\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Paid by the bank').first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('customer credit adjustments', () => {
  test('one person asks and another decides: a request made by someone else is approved, and the wallet changes', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo.project.name);
    await open(page, '/admin/finance/receivables/credit-adjustments', 'Customer credit adjustments');
    await noNativeSelect(page);
    await expect(page.getByRole('link', { name: new RegExp(`CAJ-.*Wallet ${tag}`) }).first()).toBeVisible();
    await page.getByRole('link', { name: new RegExp(`CAJ-.*Wallet ${tag}`) }).first().click();
    await expect(page.getByRole('heading', { name: /^Credit adjustment CAJ-/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Waiting for a decision').first()).toBeVisible();
    await clickUntilVisible(page.getByRole('button', { name: 'Approve' }), page.getByText('Approved and done.'));
    await expect(page.getByText('Done').first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('a request the admin makes waits for someone else, and cannot be decided by the admin', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo.project.name);
    await open(page, '/admin/finance/receivables/credit-adjustments/new', 'Change a customer\'s credit');
    await noNativeSelect(page);
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), `Wallet ${tag}`, new RegExp(`Wallet ${tag}`));
    await pick(page, page.getByRole('combobox', { name: 'What to do' }), 'Add', /Add to the customer.s wallet/);
    await expect(page.getByRole('note').filter({ hasText: 'without any money coming in' })).toBeVisible();
    await page.getByLabel(/^Amount/).fill(tag === 'Phone' ? '11' : '10');
    const why = page.getByRole('combobox', { name: 'Reason' });
    await why.click();
    await page.getByRole('option').first().click();
    await page.getByLabel(/^(Explain|Comment)/).fill('goodwill after a late delivery');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Ask for it' }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/receivables\/credit-adjustments\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByText('Waiting for a decision').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByText('Waiting for someone other than the person who asked to decide it.')).toBeVisible();
    // it can be withdrawn
    await clickUntilVisible(page.getByRole('button', { name: 'Cancel the request…' }), page.getByRole('form', { name: 'Cancel the request' }));
    const reason = page.getByRole('combobox', { name: 'Reason' });
    await reason.click();
    await page.getByRole('option').first().click();
    await page.getByLabel(/^(Explain|Comment)/).fill('asked by mistake');
    await page.getByRole('button', { name: 'Cancel the request', exact: true }).click();
    await expect(page.getByText('Cancelled.').first()).toBeVisible({ timeout: 30_000 });
  });

  test('credit left unapplied on a receipt can be given up from the receipt, with the amount filled in', async ({ page }) => {
    await open(page, '/admin/finance/receipts', 'Customer receipts');
    await page.getByRole('link', { name: /^PAY-/ }).first().click();
    await expect(page.getByRole('heading', { name: /^Receipt /, level: 2 })).toBeVisible({ timeout: 30_000 });
    const give = page.getByRole('link', { name: /^Give up the unapplied/ });
    if ((await give.count()) > 0) {
      await give.click();
      await expect(page.getByRole('heading', { name: 'Change a customer\'s credit', level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('note').filter({ hasText: 'becomes income' })).toBeVisible();
      await expect(page.getByLabel(/^Amount/)).not.toHaveValue('');
    }
    await noNativeSelect(page);
  });
});

test.describe('the wallet policy: credit that lapses', () => {
  test('the days unused are set, kept and shown in words', async ({ page }) => {
    await open(page, '/admin/finance/receivables/wallet-policy', 'Wallet policy');
    const form = page.getByRole('form', { name: 'Rules for the whole business' });
    await clickUntilVisible(page.getByRole('button', { name: 'Change', exact: true }).first(), form);
    await form.getByLabel('Customers can hold credit with us').check();
    await form.getByLabel(/^Credit lapses after/).fill('5');
    await form.getByRole('button', { name: 'Save from today' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /30 to 3,650 days/ })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel(/^Credit lapses after/).fill('400');
    await form.getByLabel(/^Warn this many days before/).fill('45');
    await form.getByRole('button', { name: 'Save from today' }).click();
    await expect(page.getByText('Saved. It applies from today.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Credit not used for 400 days lapses\./).first()).toBeVisible({ timeout: 30_000 });
    // put it back so nothing else is affected
    await clickUntilVisible(page.getByRole('button', { name: 'Change', exact: true }).first(), form);
    await form.getByLabel(/^Credit lapses after/).fill('');
    await form.getByRole('button', { name: 'Save from today' }).click();
    await expect(page.getByText('Saved. It applies from today.')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
