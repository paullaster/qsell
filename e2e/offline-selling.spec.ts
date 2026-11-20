import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct } from './support/storefront-fixtures';

/** Types into a picker and takes the first option offered (the page is drawn before it is wired up, so try until it takes). */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 120_000 });
}

test.describe('selling with no connection', () => {
  test('is switched on in Settings; a sale is rung up with the connection cut, the till keeps its page and the sale on the device, and the sale becomes a real receipt when the connection returns', async ({ page, context }, testInfo) => {
    test.slow();
    const tag = `ol${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const tillName = `Offline till ${tag}`;
    const productName = makeProduct(tag);

    // Switched on, in its own screen, with a reason.
    await gotoAdmin(page, '/admin/settings/offline-selling', 'Offline selling');
    await noNativeSelect(page);
    await expect(page.getByTestId('offline-acceptance')).toContainText('provisional slip');
    const form = page.getByRole('form', { name: 'Offline selling' });
    const allow = form.getByLabel('Allow tills to sell with no connection');
    await expect(allow).toBeVisible({ timeout: 60_000 });
    // The desktop run may have switched it on already (both runs share one database): then there is nothing to save.
    if (!(await allow.isChecked())) {
      await expect(async () => {
        await allow.check();
        await expect(allow).toBeChecked({ timeout: 3000 });
      }).toPass({ timeout: 120_000 });
      await expect(async () => {
        await form.getByRole('combobox', { name: /Reason/ }).click();
        await page.getByRole('option').first().click({ timeout: 4000 });
        await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 3000 });
      }).toPass({ timeout: 120_000 });
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Saved\. Tills pick it up/)).toBeVisible({ timeout: 30_000 });
    }

    // A till and an open shift, while online.
    await gotoAdmin(page, '/admin/settings/registers', 'Registers');
    await expect(async () => {
      await page.getByRole('button', { name: 'Add a till' }).click();
      await expect(page.getByRole('form', { name: 'Add a till' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 120_000 });
    const add = page.getByRole('form', { name: 'Add a till' });
    await add.getByLabel('Name of the till').fill(tillName);
    await expect(async () => {
      await add.getByRole('combobox', { name: /Branch/ }).click();
      await page.getByRole('option').first().click({ timeout: 4000 });
    }).toPass({ timeout: 120_000 });
    await add.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Till added.')).toBeVisible({ timeout: 30_000 });
    await gotoAdmin(page, '/admin/shifts', 'Shifts');
    const open = page.getByRole('form', { name: 'Open a shift' });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await pick(page, open.getByRole('combobox', { name: /Till/ }), tillName);
    await open.getByLabel('How many 1000 shilling notes').fill('2');
    await open.getByRole('button', { name: 'Open shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift opened.', { timeout: 30_000 });

    // The counter keeps itself ready, and the offline till opens.
    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('offline-ready')).toContainText('Ready to sell with no connection', { timeout: 120_000 });
    await page.goto('/admin/cash-sales/offline');
    await expect(page.getByTestId('till-connection')).toContainText('Connected', { timeout: 60_000 });
    await expect(page.getByTestId('till-not-ready')).toHaveCount(0);
    await noHorizontalScroll(page);
    // Give the worker a moment to keep the page and its files.
    await page.waitForTimeout(3000);

    // The connection is cut: the till says so, and still sells.
    await context.setOffline(true);
    await expect(page.getByTestId('till-connection')).toContainText('No connection', { timeout: 30_000 });
    await expect(async () => {
      const field = page.getByRole('combobox', { name: 'Add a product' });
      await field.click();
      await field.fill(productName);
      await page.getByRole('option', { name: new RegExp(productName) }).first().click({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await page.getByLabel(`Quantity of ${productName}`).fill('2');
    await expect(page.getByTestId('sale-total')).toContainText('KES', { timeout: 15_000 });
    const tender = page.getByTestId('tender').first();
    await tender.getByRole('combobox', { name: /Paid with/ }).click();
    await page.getByRole('option', { name: /E2E Cash/ }).first().click();
    await tender.getByLabel('Handed over (KES)').fill('1000000');
    await expect(page.getByTestId('sale-change')).toContainText('Change to give', { timeout: 15_000 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Complete sale' }).click();
    const slip = page.getByTestId('till-slip');
    await expect(slip).toContainText('Slip OFF-', { timeout: 30_000 });
    await expect(slip).toContainText('tax receipt follows');
    await expect(page.getByTestId('till-status')).toContainText('1 sale(s) waiting to be sent');

    // The till has kept what it needs on this device: the page (in the worker's cache) and the sale (in the browser's own memory).
    // (A reload with no connection is not tried here: the test browser's offline switch does not reach the service worker's own requests.)
    const kept = await page.evaluate(async () => {
      const hit = await caches.match('/admin/cash-sales/offline');
      const waiting = await new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('qsell-offline-till');
        open.onerror = () => reject(new Error('no memory'));
        open.onsuccess = () => {
          const count = open.result.transaction('outbox', 'readonly').objectStore('outbox').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(new Error('no count'));
        };
      });
      return { page: hit !== undefined, waiting };
    });
    expect(kept).toEqual({ page: true, waiting: 1 });

    // The connection returns: the sale is sent and becomes a real receipt.
    await context.setOffline(false);
    await expect(page.getByTestId('till-sent')).toContainText('is now receipt RCT-', { timeout: 120_000 });
    await expect(page.getByTestId('till-status')).toContainText('Nothing waiting to be sent', { timeout: 60_000 });

    // It is in the shift's sales and the shift can be closed.
    await gotoAdmin(page, '/admin/cash-sales', 'Cash Sales');
    await expect(page.getByTestId('sale-row').first()).toContainText('RCT-', { timeout: 60_000 });
    await gotoAdmin(page, '/admin/shifts', 'Shifts');
    const x = page.getByTestId('x-report');
    await expect(x).toContainText('Cash sales', { timeout: 60_000 });
    const shouldHold = Number(/KES\s*([\d,]+\.\d{2})/.exec((await x.innerText()).split('The till should hold')[1] ?? '')?.[1]?.replace(/,/g, '') ?? Number.NaN);
    expect(shouldHold).toBeGreaterThan(2000);
    const close = page.getByRole('form', { name: 'Close the shift' });
    await close.getByText('I only have a total').click();
    await close.getByLabel('Total counted (KES)').fill(String(shouldHold));
    await close.getByRole('button', { name: 'Close shift' }).click();
    await expect(page.getByTestId('shift-notice')).toContainText('Shift closed. Z report', { timeout: 30_000 });
  });
});
