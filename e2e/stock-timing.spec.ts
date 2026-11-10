import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { stockTool } from './support/stock-fixtures';
import { openOrder, placeDeliveredOrder, step } from './support/delivery-shop';

/**
 * Files run in name order against one database. The second test here gives the seeded salt per-location stock history and then
 * switches the ledger off again, which the stock-ledger spec's whole-database check (it expects products with no per-location
 * history) would rightly refuse, so this file must stay after stock-ledger.spec.ts: keep it named so.
 */

test.describe('stock timing', () => {
  test('shows when stock leaves, explains each choice, and refuses a later moment until stock is kept by location', async ({ page }) => {
    test.slow();
    await open(page, '/admin/delivery/stock', 'Stock timing');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    // The test shop keeps stock the old way, so it can only leave when the order is paid, and the page says so.
    await expect(page.getByRole('status').filter({ hasText: 'not yet kept by location' })).toBeVisible();
    await expect(page.getByText('In use now:')).toContainText('When the order is paid');
    const picker = page.getByRole('combobox', { name: 'The stock of a delivered order leaves the shelf' });
    await pick(page, picker, 'goes out', /When a delivery goes out/);
    await expect(page.getByText('Only what that delivery carries leaves the shelf.')).toBeVisible();
    await page.getByRole('region', { name: 'When stock leaves' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'kept by location' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('In use now:')).toContainText('When the order is paid');
    await noHorizontalScroll(page);
  });

  test('with stock kept by location and issued as a delivery goes out, the shelf moves with the delivery, the shop is not misled, and returned goods go back on the shelf', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      stockTool('ledger', 'on');
      stockTool('stockup', 'Salt 500g', '100');
      const shelf = () => Number(stockTool('onhand', 'Salt 500g').quantity);
      const shop = () => Number(stockTool('shopsees', 'Salt 500g').available);
      const before = shelf();
      const shopBefore = shop();

      // An order paid before the choice was made: its stock left the shelf when it was paid.
      const orderNumber = await placeDeliveredOrder(page);
      expect(shelf()).toBe(before - 2);
      expect(shop()).toBe(shopBefore - 2);

      await open(page, '/admin/delivery/stock', 'Stock timing');
      await pick(page, page.getByRole('combobox', { name: 'The stock of a delivered order leaves the shelf' }), 'goes out', /When a delivery goes out/);
      await page.getByRole('region', { name: 'When stock leaves' }).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/^Saved\./)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('In use now:')).toContainText('When a delivery goes out');

      // Applying the choice to orders already paid: the stock of goods that have not left is counted back and held for the order.
      const paid = page.getByRole('region', { name: 'Orders already paid' });
      await expect(paid).toContainText('paid before this choice', { timeout: 30_000 });
      await noHorizontalScroll(page);
      await paid.getByRole('button', { name: 'Apply the choice to orders already paid' }).click();
      await paid.getByRole('button', { name: 'Confirm: Apply the choice to orders already paid' }).click();
      await expect(paid.getByText(/^Done\./)).toBeVisible({ timeout: 60_000 });
      expect(shelf()).toBe(before);
      expect(shop()).toBe(shopBefore - 2);
      await expect(paid).toContainText('Nothing to change', { timeout: 30_000 }).catch(() => undefined);

      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Deliveries' });
      await panel.getByLabel(/Salt 500g \(up to 2\)/).fill('1');
      await panel.getByRole('button', { name: 'Make the delivery' }).click();
      const made = panel.getByRole('link', { name: /^DLV-/ }).first();
      await expect(made).toBeVisible({ timeout: 30_000 });
      await clickUntilVisible(made, page.getByRole('heading', { name: /^Delivery DLV-/, level: 2 }));
      for (const [button, done] of [['Release for picking', 'Released for picking.'], ['Start picking', 'Picking started.'], ['Record what was picked', 'What was picked is recorded.'], ['Mark packed', 'Marked packed.'], ['Mark ready to go', 'Marked ready to go.']] as const) await step(page, button, done);
      expect(shelf()).toBe(before);

      // Sent out: only the one packet it carries leaves the shelf; what the shop offers does not change.
      await step(page, 'Send out', 'Sent out.');
      expect(shelf()).toBe(before - 1);
      expect(shop()).toBe(shopBefore - 2);
      await expect(page.getByText('Left the shelf: 1')).toBeVisible();

      // It comes back: counted onto the shelf again, held again for the order, and the shop still offers no more than before.
      await pick(page, page.getByRole('combobox', { name: 'Why it did not happen' }), 'Nobody', /Nobody was there/);
      await step(page, 'Record a failed attempt', 'The failed attempt is recorded.');
      await page.getByLabel('Why it is being returned').fill('Customer is away for a week');
      await page.getByRole('button', { name: 'Return this delivery' }).click();
      await page.getByRole('button', { name: 'Confirm: Return this delivery' }).click();
      await expect(page.getByText(/^Returned\./).first()).toBeVisible({ timeout: 30_000 });
      const section = page.getByRole('region', { name: 'Goods that came back' });
      await expect(section).toContainText('It can be: Put back into stock, Quarantine (not for sale), Scrap / write off');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await pick(page, section.getByRole('combobox', { name: /What to do with it/ }), 'Put back', /Put back into stock/);
      await section.getByRole('button', { name: 'Receive these goods' }).click();
      await expect(page.getByText('The returned goods are received.').first()).toBeVisible({ timeout: 30_000 });
      await expect(section).toContainText('Received 1: Put back into stock');
      expect(shelf()).toBe(before);
      expect(shop()).toBe(shopBefore - 2);

      // A mistake in the receipt is corrected, with its reason: the packet turns out to be crushed.
      await section.getByText('Correct this receipt').click();
      await pick(page, section.getByRole('combobox', { name: /Corrected choice/ }), 'Scrap', /Scrap \/ write off/);
      await section.getByRole('button', { name: 'Correct the receipt' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'few words' })).toBeVisible({ timeout: 30_000 });
      await section.getByLabel('Why it is being corrected').fill('The packet was crushed');
      await section.getByRole('button', { name: 'Correct the receipt' }).click();
      await expect(page.getByText('The receipt is corrected.').first()).toBeVisible({ timeout: 30_000 });
      await expect(section).toContainText('Received 1: Scrap / write off');
      await expect(section).toContainText('corrected (revision 2): The packet was crushed');
      await expect(section).toContainText('Before: 1, Put back into stock (revision 1)');
      expect(shelf()).toBe(before - 1);
      expect(shop()).toBe(shopBefore - 3);
      await expect(page.getByRole('region', { name: 'History' })).toContainText('Receipt corrected');

      // The order's timeline says so.
      await openOrder(page, orderNumber);
      await expect(page.getByRole('dialog')).toContainText('Returned to stock');
    } finally {
      stockTool('timing', 'payment');
      stockTool('ledger', 'off');
      deliveryTool('close', tag);
    }
  });
});
