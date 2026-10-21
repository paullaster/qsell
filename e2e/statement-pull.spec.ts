import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { FAKE_BANK_PORT } from './support/constants';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

/** A stand-in for Jenga on this machine: it signs in anyone and answers a full-statement call with three transactions. */
let bank: Server | null = null;
let label = 'none';
const day = (back: number) =>
  new Date(Date.now() - back * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Africa/Nairobi',
  });

test.beforeAll(async () => {
  bank = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/authenticate/merchant') === true) {
        res.end(JSON.stringify({ accessToken: 'tok', tokenType: 'Bearer' }));
        return;
      }
      const tx = (
        n: number,
        amount: number,
        type: 'Credit' | 'Debit',
        back: number,
        words: string,
      ) => ({
        reference: `${label}-REF${String(n)}`,
        date: `${day(back)}T10:00:0${String(n)}.000`,
        postedDateTime: `${day(back)}T10:00:0${String(n)}.000`,
        amount,
        serial: String(n),
        description: `${words} ${label}`,
        type,
        runningBalance: { amount: 5000 + n, currency: 'KES' },
      });
      res.end(
        JSON.stringify({
          status: true,
          code: 0,
          message: 'Success',
          data: {
            balance: 1,
            currency: 'KES',
            accountNumber: '0099887766',
            transactions: [
              tx(3, 75, 'Debit', 1, 'Transfer fee'),
              tx(2, 1200.5, 'Credit', 2, 'Customer deposit'),
              tx(1, 30, 'Credit', 3, 'Interest'),
            ],
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => bank?.listen(FAKE_BANK_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (bank === null ? resolve() : bank.close(() => resolve())));
});

test.describe('pulling a statement from the bank', () => {
  test('lines are read through the bank connection, kept once, and a second pull adds nothing', async ({
    page,
  }, testInfo) => {
    label = testInfo.project.name === 'phone' ? 'phone' : 'desktop';
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EJENGA/ }).click();
    await expect(page.getByRole('heading', { name: /E2EJENGA/, level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await noNativeSelect(page);

    const pull = page.getByRole('button', { name: 'Pull from the bank' });
    await expect(async () => {
      await pull.click();
      await expect(
        page.getByRole('form', { name: 'Pull the statement from the bank' }),
      ).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const form = page.getByRole('form', { name: 'Pull the statement from the bank' });
    await expect(form).toContainText('Jenga e2e');
    // The first day after the last: the browser allows it, so the server says why not.
    await form.getByLabel('From (first day)').fill(day(0));
    await form.getByLabel('To (last day)').fill(day(3));
    await form.getByRole('button', { name: 'Pull the statement' }).click();
    await expect(form.getByRole('alert')).toContainText(/must not be after/, { timeout: 30_000 });
    await form.getByLabel('From (first day)').fill(day(7));
    await form.getByLabel('To (last day)').fill(day(0));

    await form.getByRole('button', { name: 'Pull the statement' }).click();
    await expect(page.getByText(/Kept 3 new lines/)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('listitem').filter({ hasText: `Customer deposit ${label}` }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('listitem').filter({ hasText: `Transfer fee ${label}` }),
    ).toBeVisible();

    // The same days again: nothing is added twice.
    await page.getByRole('button', { name: 'Pull from the bank' }).click();
    await expect(
      page.getByRole('form', { name: 'Pull the statement from the bank' }),
    ).toContainText(/Last pull/, { timeout: 30_000 });
    await page
      .getByRole('form', { name: 'Pull the statement from the bank' })
      .getByRole('button', { name: 'Pull the statement' })
      .click();
    await expect(page.getByText(/Nothing new: all 3 lines were already kept\./)).toBeVisible({
      timeout: 30_000,
    });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('an account that is not connected to a bank says so and cannot be pulled', async ({
    page,
  }) => {
    await open(page, '/admin/finance/bank-statements', 'Bank statements');
    await page.getByRole('link', { name: /E2EBANK/ }).click();
    await expect(page.getByRole('heading', { name: /E2EBANK/, level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await expect(async () => {
      await page.getByRole('button', { name: 'Pull from the bank' }).click();
      await expect(
        page.getByRole('form', { name: 'Pull the statement from the bank' }),
      ).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const form = page.getByRole('form', { name: 'Pull the statement from the bank' });
    await expect(form.getByRole('alert')).toContainText('not connected to a bank yet');
    await expect(form.getByRole('button', { name: 'Pull the statement' })).toBeDisabled();
    await noHorizontalScroll(page);
  });
});
