import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct } from './support/storefront-fixtures';
import { amountOf, closeCart, closeShiftRight, openCart, openShiftOnNewTill, tapProduct } from './support/till-kit';

test.describe('the till screen', () => {
  test('products are tiles: tapping adds and counts, a sale is held and brought back, a payment is split with a number pad, and the receipt shows the change', async ({ page }, testInfo) => {
    test.slow();
    const tag = `tl${String(Date.now()).slice(-6)}`;
    const first = makeProduct(`${tag}a`);
    const second = makeProduct(`${tag}b`);
    const tillName = await openShiftOnNewTill(page, testInfo, tag);

    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('shift-bar')).toContainText(tillName, { timeout: 60_000 });
    await expect(page.getByTestId('till-tile').first()).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Tapping a tile adds it; tapping again adds one more, and the tile says how many are in the sale.
    await tapProduct(page, first);
    await page.getByTestId('till-tile').filter({ hasText: first }).first().click();
    await expect(page.getByTestId('tile-count').first()).toHaveText('2');
    await openCart(page);
    await expect(page.getByTestId('sale-line')).toHaveCount(1);
    await expect(page.getByLabel(`Quantity of ${first}`)).toHaveValue('2');
    await expect(page.getByTestId('till-pay')).toBeEnabled({ timeout: 60_000 });
    const priceOfTwo = amountOf(await page.getByTestId('sale-total').innerText());
    await page.getByRole('button', { name: `One more ${first}` }).click();
    await expect(page.getByLabel(`Quantity of ${first}`)).toHaveValue('3');
    await page.getByRole('button', { name: `One less ${first}` }).click();
    await expect(page.getByLabel(`Quantity of ${first}`)).toHaveValue('2');

    // Hold it, serve someone else, and bring it back; a held sale cannot be brought back over another.
    const heldButton = page.getByTestId('till-held-button').or(page.getByTestId('till-held-bar')).first();
    // With the sale sheet open on a phone, the sheet's own button is the one in reach.
    const openHeld = async () => {
      const sheet = page.getByRole('dialog', { name: 'The sale' });
      if (await sheet.isVisible()) await sheet.getByTestId('till-held-button').click();
      else await heldButton.click();
    };
    await page.getByRole('button', { name: /^Hold/ }).click();
    await closeCart(page);
    await expect(heldButton).toContainText('1', { timeout: 30_000 });
    await tapProduct(page, second);
    await openCart(page);
    await openHeld();
    await page.getByRole('button', { name: /Bring back/ }).click();
    await expect(page.getByRole('dialog', { name: 'Sales on hold' }).getByRole('alert')).toContainText('Finish or put aside');
    await page.keyboard.press('Escape');
    await page.getByTestId('till-clear').click();
    await openCart(page);
    await expect(page.getByTestId('sale-empty')).toBeVisible();
    await openHeld();
    await expect(page.getByTestId('held-row')).toHaveCount(1);
    await page.getByRole('button', { name: /Bring back/ }).click();
    await expect(page.getByTestId('sale-line')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByLabel(`Quantity of ${first}`)).toHaveValue('2');
    await expect(page.getByTestId('till-held-button')).not.toContainText('1');
    await expect(page.getByTestId('till-pay')).toBeEnabled({ timeout: 60_000 });
    expect(amountOf(await page.getByTestId('sale-total').innerText())).toBe(priceOfTwo);

    // Pay: 100 in cash from the number pad, the rest by M-Pesa with its code; the change is nil and the sale completes.
    await page.getByTestId('till-pay').click();
    await expect(page.getByTestId('pay-total')).toContainText('KES');
    await page.getByTestId('pay-method').filter({ hasText: 'E2E Cash' }).click();
    for (const key of ['1', '00']) await page.getByRole('group', { name: 'Number pad' }).getByRole('button', { name: key, exact: true }).click();
    await expect(page.getByTestId('pay-amount')).toHaveValue('100');
    await page.getByTestId('pay-add').click();
    await expect(page.getByTestId('pay-state')).toContainText('Still to pay');
    await page.getByTestId('pay-method').filter({ hasText: 'M-Pesa' }).click();
    await page.getByTestId('pay-full').click();
    // (The e2e M-Pesa method does not ask for a code; a method that does shows the field and holds Complete until it is filled.)
    if ((await page.getByTestId('pay-reference').count()) > 0) await page.getByTestId('pay-reference').fill('QWE123RTY4');
    await expect(page.getByTestId('pay-state')).toContainText('Paid in full');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await page.getByTestId('pay-complete').click();
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toContainText('Receipt RCT-', { timeout: 60_000 });
    await expect(receipt).toContainText('M-Pesa');
    await expect(page.getByTestId('receipt-change')).toContainText('0.00');
    // What is printed is its own slip: the shop, the items and the total, not the page.
    const slip = page.getByTestId('receipt-print');
    await expect(slip).toHaveCount(1);
    await expect(slip).toContainText('TOTAL');
    await expect(slip.locator('.row')).not.toHaveCount(0);
    await receipt.getByRole('button', { name: 'New sale' }).click();
    await closeCart(page);
    await expect(page.getByTestId('shift-bar')).toContainText('1 sale(s) so far', { timeout: 30_000 });

    await closeShiftRight(page);
  });

  test('the full-screen setting gives the whole screen to the till, with its own top bar and an Exit, and can be set back', async ({ page }, testInfo) => {
    test.slow();
    const tag = `fs${String(Date.now()).slice(-6)}`;
    await openShiftOnNewTill(page, testInfo, tag);

    await gotoAdmin(page, '/admin/settings/sales/cash-sales', 'Cash Sales');
    await noNativeSelect(page);
    const choose = async (label: string) => {
      await expect(async () => {
        await page.locator('label', { hasText: label }).click({ timeout: 3000 });
        const save = page.getByRole('button', { name: 'Save', exact: true });
        await expect(save).toBeEnabled({ timeout: 3000 });
        await save.click();
        await expect(page.getByText(/Saved\. Tills show this/)).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 60_000 });
    };
    await choose('Full-screen till');

    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('till-fullscreen')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('till-exit')).toBeVisible();
    await expect(page.getByTestId('till-tile').first()).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await page.getByTestId('till-sales-button').click();
    await expect(page.getByRole('dialog', { name: 'Sales' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('till-exit').click();
    await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });

    await gotoAdmin(page, '/admin/settings/sales/cash-sales', 'Cash Sales');
    await choose('Inside the admin page');
    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('till-inline')).toBeVisible({ timeout: 60_000 });

    await closeShiftRight(page);
  });

  test('a person who may change prices can type a new price for an item in the sale, and go back to the list price', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pr${String(Date.now()).slice(-6)}`;
    const item = makeProduct(`${tag}a`);
    await openShiftOnNewTill(page, testInfo, tag);
    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('till-tile').first()).toBeVisible({ timeout: 60_000 });
    await tapProduct(page, item);
    await openCart(page);
    await expect(page.getByTestId('till-pay')).toBeEnabled({ timeout: 60_000 });
    const listed = amountOf(await page.getByTestId('sale-total').innerText());

    await page.getByTestId('price-edit').click();
    await page.getByTestId('price-input').fill('1.00');
    await page.getByTestId('price-apply').click();
    await expect(page.getByTestId('sale-total')).toContainText('1.00', { timeout: 30_000 });
    await expect(page.getByTestId('price-edit')).toContainText('price changed');

    await page.getByTestId('price-reset').click();
    await expect(page.getByTestId('sale-total')).toContainText(listed.toFixed(2), { timeout: 30_000 });
    await expect(page.getByTestId('price-edit')).not.toContainText('price changed');
    await page.getByTestId('till-clear').click();
    await closeCart(page);
    await closeShiftRight(page);
  });
});
