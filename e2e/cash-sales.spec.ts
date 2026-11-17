import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct } from './support/storefront-fixtures';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

const amountOf = (text: string): number => Number(/KES\s*([\d,]+\.\d{2})/.exec(text)?.[1]?.replace(/,/g, '') ?? Number.NaN);

test.describe('cash sales at the counter', () => {
  test('a sale is rung up in an open shift: the total is priced by the server, cash is taken with change, the receipt is on the POS series, and the till and the shift report show it', async ({ page }, testInfo) => {
    test.slow();
    const tag = `cs${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const tillName = `Counter ${tag}`;
    const productName = makeProduct(tag);

    // A till, then no sale without a shift.
    await gotoAdmin(page, '/admin/settings/registers', 'Registers');
    await expect(async () => {
      await page.getByRole('button', { name: 'Add a till' }).click();
      await expect(page.getByRole('form', { name: 'Add a till' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const add = page.getByRole('form', { name: 'Add a till' });
    await add.getByLabel('Name of the till').fill(tillName);
    await expect(async () => {
      const branch = add.getByRole('combobox', { name: /Branch/ });
      await branch.click();
      await page.getByRole('option').first().click({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await add.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Till added.')).toBeVisible({ timeout: 30_000 });

    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('no-shift')).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);

    // Open the shift with 5,000 in the drawer.
    await gotoAdmin(page, '/admin/shifts', 'Shifts');
    const open = page.getByRole('form', { name: 'Open a shift' });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await pick(page, open.getByRole('combobox', { name: /Till/ }), tillName);
    await open.getByLabel('How many 1000 shilling notes').fill('5');
    await open.getByRole('button', { name: 'Open shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift opened.', { timeout: 30_000 });

    // The counter: add the product, see the total the server works out.
    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('shift-bar')).toContainText(tillName, { timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await pick(page, page.getByRole('combobox', { name: 'Add a product' }), productName);
    await page.getByLabel(`Quantity of ${productName}`).fill('2');
    await expect(page.getByTestId('sale-total')).toContainText('KES', { timeout: 60_000 });
    const total = amountOf(await page.getByTestId('sale-total').innerText());
    expect(total).toBeGreaterThan(0);

    // Cash that is short is refused on the screen, with the amount; enough cash shows the change.
    const tender = page.getByTestId('tender').first();
    await pick(page, tender.getByRole('combobox', { name: /Paid with/ }), 'E2E Cash');
    await tender.getByLabel('Handed over (KES)').fill('1');
    await expect(page.getByTestId('sale-plan-problem')).toContainText('The cash is short', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Complete sale' })).toBeDisabled();
    await tender.getByLabel('Handed over (KES)').fill('1000000');
    await expect(page.getByTestId('sale-change')).toContainText('Change to give', { timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await noNativeSelect(page);
    await page.getByRole('button', { name: 'Complete sale' }).click();

    // The receipt: on the POS series, with the change, and the sale is in the list.
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toContainText('Receipt RCT-', { timeout: 60_000 });
    await expect(page.getByTestId('receipt-change')).toContainText(/KES\s*999,/);
    await expect(page.getByTestId('sale-row').first()).toContainText('RCT-', { timeout: 30_000 });
    await expect(page.getByTestId('shift-bar')).toContainText('1 sale(s) so far');
    await receipt.getByRole('button', { name: 'New sale' }).click();
    await expect(page.getByTestId('sale-empty')).toBeVisible();

    // The shift's X report shows the cash taken; close it counting exactly what the till should hold.
    await gotoAdmin(page, '/admin/shifts', 'Shifts');
    const x = page.getByTestId('x-report');
    await expect(x).toContainText('Cash sales', { timeout: 60_000 });
    const shouldHold = amountOf((await x.innerText()).split('The till should hold')[1] ?? '');
    expect(shouldHold).toBeCloseTo(5000 + total, 1);
    const close = page.getByRole('form', { name: 'Close the shift' });
    await close.getByText('I only have a total').click();
    await close.getByLabel('Total counted (KES)').fill(String(shouldHold));
    await close.getByRole('button', { name: 'Close shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift closed. Z report', { timeout: 30_000 });
    await expect(page.getByTestId('z-report')).toContainText('Cash sales');
  });
});
