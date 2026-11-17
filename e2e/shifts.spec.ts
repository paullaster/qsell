import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';

/** Chooses the first option a picker offers once its list has loaded (the page is drawn before it is wired up, so try until it takes). */
async function pickFirst(page: Page, field: Locator): Promise<void> {
  await expect(async () => {
    await field.click();
    await page.getByRole('option').first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('till shifts', () => {
  test('a till is set up, a shift is opened with the float counted, cash goes in and out, and it is closed with the cash counted and a Z report', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const tillName = `Front till ${tag}`;

    // Set up the till (Settings, Registers) and how far a till may be out.
    await gotoAdmin(page, '/admin/settings/registers', 'Registers');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(async () => {
      await page.getByRole('button', { name: 'Add a till' }).click();
      await expect(page.getByRole('form', { name: 'Add a till' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const add = page.getByRole('form', { name: 'Add a till' });
    await add.getByLabel('Name of the till').fill(tillName);
    await pickFirst(page, add.getByRole('combobox', { name: /Branch/ }));
    await add.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Till added.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('register').filter({ hasText: tillName })).toContainText('In use');
    const tolerance = page.getByRole('form', { name: 'How far a till may be out' });
    await expect(tolerance.getByLabel('An amount (KES)')).toHaveValue('100');
    await noNativeSelect(page);

    // Open a shift on it with the float counted: 5 × 1000 and 4 × 500 = 7,000.
    await gotoAdmin(page, '/admin/shifts', 'Shifts');
    const open = page.getByRole('form', { name: 'Open a shift' });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      const till = open.getByRole('combobox', { name: /Till/ });
      await till.click();
      await till.fill(tillName);
      await page.getByRole('option', { name: new RegExp(tillName) }).first().click({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await open.getByLabel('How many 1000 shilling notes').fill('5');
    await open.getByLabel('How many 500 shilling notes').fill('4');
    await expect(open.getByTestId('counted-total')).toContainText('KES 7,000.00');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await open.getByRole('button', { name: 'Open shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift opened.', { timeout: 30_000 });

    // The X report shows what the till should hold; cash in and out change it, each with its reason.
    const x = page.getByTestId('x-report');
    await expect(x).toContainText('The till should hold');
    await expect(x).toContainText('KES 7,000.00');
    const cash = page.getByRole('form', { name: 'Cash in or out' });
    await cash.getByLabel('Amount (KES)').fill('500');
    await cash.getByLabel('Why').fill('float top-up from the safe');
    await cash.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByTestId('x-report')).toContainText('KES 7,500.00', { timeout: 30_000 });
    await cash.locator('label').filter({ hasText: /^Take out$/ }).click();
    await cash.getByLabel('Amount (KES)').fill('200');
    await cash.getByLabel('Why').fill('bought tea for the shop');
    await cash.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByTestId('x-report')).toContainText('KES 7,300.00', { timeout: 30_000 });
    await expect(page.getByTestId('shift-movements')).toContainText('bought tea for the shop');

    // Close it counting 7,250 (50 short, within the limit): it needs a reason, then it is numbered.
    const close = page.getByRole('form', { name: 'Close the shift' });
    await close.getByLabel('How many 1000 shilling notes').fill('7');
    await close.getByLabel('How many 200 shilling notes').fill('1');
    await close.getByLabel('How many 50 shilling notes').fill('1');
    await expect(close.getByTestId('counted-total')).toContainText('KES 7,250.00');
    await close.getByRole('button', { name: 'Close shift' }).click();
    await expect(close.getByTestId('shift-problem')).toContainText('There is a difference', { timeout: 30_000 });
    await close.getByLabel('Reason for any difference').fill('gave a customer the wrong change');
    await close.getByRole('button', { name: 'Close shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift closed. Z report', { timeout: 30_000 });
    const z = page.getByTestId('z-report');
    await expect(z).toBeVisible();
    await expect(z).toContainText('Counted at the close');
    await expect(z).toContainText('gave a customer the wrong change');
    await expect(z).toContainText(tillName);

    // It is in the history with its Z number and the difference.
    const row = page.getByTestId('shift-row').filter({ hasText: tillName }).first();
    await expect(row).toContainText('Z-', { timeout: 30_000 });
    await expect(row).toContainText('Difference');
    await noHorizontalScroll(page);
    await noNativeSelect(page);
  });
});
