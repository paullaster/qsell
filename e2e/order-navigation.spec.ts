import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct, makeSalesOrder, makeTradeCustomer } from './support/storefront-fixtures';

test.describe('opening an order', () => {
  test('it opens over the screen it was opened from, shows who and how much first, and closing it goes back to that screen; by its own address it is a page with the way back', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const tag = `on${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const customer = makeTradeCustomer(tag);
    const number = makeSalesOrder(customer, makeProduct(tag));
    expect(number).not.toBe('');

    // From the sales orders list: the button says what it does, the order opens over the list.
    await gotoAdmin(page, '/admin/sales-orders', 'Sales orders');
    await expect(page.getByLabel('Find a sales order')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Find a sales order').fill(number);
    const row = page.getByTestId('sales-order').filter({ hasText: number });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    const open = row.getByRole('link', { name: `Open order ${number}` });
    const href = (await open.getAttribute('href')) ?? '';
    expect(href).toMatch(/^\/admin\/orders\/view\/[\w-]+$/);
    await expect(async () => {
      await open.click();
      await expect(page.getByRole('dialog', { name: `Sales order ${number}` })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    const dialog = page.getByRole('dialog', { name: `Sales order ${number}` });

    // What matters is on top: who, when, how much and where it stands; the parts of the order are named and one press away.
    const summary = dialog.getByTestId('order-summary');
    await expect(summary).toContainText(customer);
    await expect(summary).toContainText('Total');
    await expect(summary).toContainText(/pending/i);
    for (const part of ['Customer', 'Items', 'Fulfilment', 'Payments', 'Invoices', 'History']) await expect(dialog.getByRole('button', { name: part, exact: true })).toBeVisible();
    await expect(async () => {
      await dialog.getByRole('button', { name: 'History', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'History' })).toBeInViewport({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Closing goes back to the list it was opened from, with the search still there.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\/admin\/sales-orders$/);
    await expect(page.getByLabel('Find a sales order')).toHaveValue(number);
    await expect(row).toBeVisible();

    // Escape does the same.
    await expect(async () => {
      await open.click();
      await expect(dialog).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/admin\/sales-orders$/);

    // By its own address it is a page, with the way back to the screen it belongs to.
    await page.goto(href);
    await expect(page.getByRole('heading', { name: `Sales order ${number}`, level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('order-summary')).toContainText(customer);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'Back to Sales Orders' }).click();
    await expect(page).toHaveURL(/\/admin\/sales-orders$/);

    // The older address, with the order named in the query, goes to the same page.
    await page.goto(`/admin/orders?order=${href.split('/').pop() ?? ''}`);
    await expect(page.getByRole('heading', { name: `Sales order ${number}`, level: 1 })).toBeVisible({ timeout: 60_000 });
  });

  test('from the web shop orders the same button opens the order over that list, and closing it leaves the person on that list', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const number = `E2E-CR-${testInfo.project.name.toUpperCase()}`;
    await gotoAdmin(page, '/admin/orders', 'Web Shop Orders');
    await page.getByLabel('Search orders').fill(number);
    const open = page.locator('tr, li, article').filter({ hasText: number }).getByRole('link', { name: /Open order/ }).first();
    await expect(open).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      await open.click();
      await expect(page.getByRole('dialog', { name: new RegExp(number) })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('dialog', { name: new RegExp(number) })).toContainText('Web shop order');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\/admin\/orders$/);
    await expect(page.getByLabel('Search orders')).toHaveValue(number);
  });
});
