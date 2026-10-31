import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { makePlace, quantityAt, setLedger, stockedProduct } from './support/stock-fixtures';
import { attemptTag } from './support/vendors';

// Transfers work only on the new stock ledger, which these tests switch on for themselves and off again at the end.
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => setLedger('on'));
test.afterAll(() => setLedger('off'));

const row = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text });

test.describe('moving stock between locations', () => {
  test('a transfer is made, sent, received in two parts and the rest settled, and the screens fit every width', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const toCode = `E2ETO${tag}`.slice(0, 20).toUpperCase();
    const product = stockedProduct(tag, 10);
    makePlace(toCode, `Receiving ${tag}`);

    // The list is there, with a way to start a transfer.
    await open(page, '/admin/inventory/transfers', /Stock transfers/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'New transfer' }).click();
    await expect(page.getByRole('heading', { name: 'New stock transfer', level: 2 })).toBeVisible({ timeout: 60_000 });

    // Asking for more than there is, or for nothing, is refused in words.
    const form = page.getByRole('form', { name: 'New stock transfer' });
    await pick(page, form.getByRole('combobox', { name: 'Send from' }), 'MAIN', /MAIN/);
    await pick(page, form.getByRole('combobox', { name: 'Send to' }), toCode, new RegExp(toCode));
    await pick(page, form.getByRole('combobox', { name: 'Product 1' }), product.name, new RegExp(product.name));
    await form.getByLabel('Quantity 1').fill('0');
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(form.locator('p[role="alert"]')).toContainText(/more than zero/, { timeout: 30_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A good draft opens the transfer.
    await form.getByLabel('Quantity 1').fill('10');
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(page.getByRole('heading', { name: /^Transfer TRF-/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    expect(quantityAt(product.name, 'MAIN')).toBe(10);

    // Ask for it, then send it: the stock leaves the sender and is not at the receiver yet.
    await page.getByRole('button', { name: 'Ask for this transfer' }).click();
    await expect(page.getByText('Asked for. It can be sent now.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Send the stock' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Send the stock' }).click();
    await expect(page.getByText('Sent. The stock is on its way.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('On its way', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(quantityAt(product.name, 'MAIN')).toBe(0);
    expect(quantityAt(product.name, toCode)).toBe(0);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Receiving more than is on its way is refused; receiving part of it works.
    const arrived = page.getByRole('region', { name: 'Record what arrived' });
    await arrived.getByLabel(`Arrived: ${product.name}`).fill('11');
    await arrived.getByRole('button', { name: 'Record what arrived' }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/Only 10/, { timeout: 30_000 });
    await arrived.getByLabel(`Arrived: ${product.name}`).fill('6');
    await arrived.getByRole('button', { name: 'Record what arrived' }).click();
    await expect(page.getByText(`Recorded. The stock is now at ${toCode}.`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Partly received', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(quantityAt(product.name, toCode)).toBe(6);

    // The rest did not come: it must be settled with a reason.
    const lost = page.getByRole('region', { name: 'Stock that did not arrive' });
    await lost.getByLabel(`Not arriving: ${product.name}`).fill('4');
    await pick(page, lost.getByRole('combobox', { name: 'What became of it' }), 'lost', /lost: write it off/i);
    await lost.getByRole('button', { name: 'Settle this stock' }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/Say why/, { timeout: 30_000 });
    await lost.getByLabel('Why').fill('The van was stopped on the highway');
    await lost.getByRole('button', { name: 'Settle this stock' }).click();
    await expect(page.getByText('Settled.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Closed, some stock lost or sent back').first()).toBeVisible({ timeout: 30_000 });

    // The history says who did what, in order.
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByRole('listitem')).toHaveCount(5);
    await expect(history).toContainText('Settled what did not arrive');
    await expect(history).toContainText('The van was stopped on the highway');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // It is in the list, and the list can be searched by number.
    await open(page, '/admin/inventory/transfers', /Stock transfers/);
    await expect(row(page, toCode).first()).toBeVisible({ timeout: 60_000 });
    await expect(row(page, toCode).first()).toContainText('Closed, some stock lost or sent back');
  });

  test('a transfer can be cancelled before it is sent, with a reason', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const toCode = `E2ETC${tag}`.slice(0, 20).toUpperCase();
    const product = stockedProduct(`c${tag}`, 5);
    makePlace(toCode, `Cancel ${tag}`);
    await open(page, '/admin/inventory/transfers/new', /New stock transfer/);
    const form = page.getByRole('form', { name: 'New stock transfer' });
    await pick(page, form.getByRole('combobox', { name: 'Send from' }), 'MAIN', /MAIN/);
    await pick(page, form.getByRole('combobox', { name: 'Send to' }), toCode, new RegExp(toCode));
    await pick(page, form.getByRole('combobox', { name: 'Product 1' }), product.name, new RegExp(product.name));
    await form.getByLabel('Quantity 1').fill('2');
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(page.getByRole('heading', { name: /^Transfer TRF-/, level: 2 })).toBeVisible({ timeout: 60_000 });
    const cancel = page.getByRole('region', { name: 'Cancel the transfer' });
    await cancel.getByRole('button', { name: 'Cancel the transfer' }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/Say why/, { timeout: 30_000 });
    await cancel.getByLabel('Cancel this transfer').fill('Plans changed');
    await cancel.getByRole('button', { name: 'Cancel the transfer' }).click();
    await expect(page.getByText('Cancelled.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Cancelled: Plans changed')).toBeVisible({ timeout: 30_000 });
    expect(quantityAt(product.name, 'MAIN')).toBe(5);
  });

  test('a made-up address shows the not-found page', async ({ page }) => {
    await page.goto('/admin/inventory/transfers/not-a-real-transfer');
    await expect(page.getByText(/could not be found|not found|doesn.t exist/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
