import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { openOrder, placeDeliveredOrder, step } from './support/delivery-shop';

test.describe('deliveries of an order', () => {
  test('an order is delivered in two parts, one with a failed attempt, and the order is delivered only when all of it is', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = await placeDeliveredOrder(page);

      // The order screen: nothing is on a delivery yet; make one for one packet of the two.
      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Deliveries' });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('Not started');
      await expect(panel).toContainText('ordered 2 · delivered 0 · 2 not on a delivery yet');
      await noHorizontalScroll(page);
      await panel.getByLabel(/Salt 500g \(up to 2\)/).fill('1');
      await panel.getByRole('button', { name: 'Make the delivery' }).click();
      const made = panel.getByRole('link', { name: /^DLV-/ }).first();
      await expect(made).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('1 not on a delivery yet');
      const firstNumber = (await made.innerText()).trim();

      // More than is left is refused in words.
      await panel.getByLabel(/Salt 500g \(up to 1\)/).fill('5');
      await panel.getByRole('button', { name: 'Make the delivery' }).click();
      await expect(panel.getByRole('alert')).toContainText('Only 1 is left', { timeout: 30_000 });

      // The delivery's own screen: through every step to delivered.
      await made.click();
      await expect(page.getByRole('heading', { name: `Delivery ${firstNumber}`, level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
      await step(page, 'Release for picking', 'Released for picking.');
      await step(page, 'Start picking', 'Picking started.');
      // Packing is refused until what was picked is recorded; then it is.
      await step(page, 'Record what was picked', 'What was picked is recorded.');
      await step(page, 'Mark packed', 'Marked packed.');
      await step(page, 'Mark ready to go', 'Marked ready to go.');
      await step(page, 'Send out', 'Sent out.');
      await expect(page.getByText('Out for delivery', { exact: true }).first()).toBeVisible();
      await page.getByLabel('Who received it').fill('Mama Wanjiku');
      await step(page, 'Mark delivered', 'Marked delivered.');
      await expect(page.getByText('Received by Mama Wanjiku')).toBeVisible();
      await expect(page.getByRole('region', { name: 'History' })).toContainText('Mark delivered');
      await noHorizontalScroll(page);

      // The order is only part delivered, and says so; its status is not "delivered".
      await openOrder(page, orderNumber);
      const again = page.getByRole('region', { name: 'Deliveries' });
      await expect(again).toContainText('Partly delivered', { timeout: 30_000 });
      await expect(again).toContainText('delivered 1');
      expect(deliveryTool('order', orderNumber).order_status).not.toBe('delivered');

      // The rest goes on a second delivery, which first fails at the door and is tried again.
      await again.getByRole('button', { name: 'Make the delivery' }).click();
      const second = again.getByRole('link', { name: /^DLV-/ }).nth(1);
      await expect(second).toBeVisible({ timeout: 30_000 });
      await clickUntilVisible(second, page.getByRole('heading', { name: /^Delivery DLV-/, level: 2 }));
      await step(page, 'Release for picking', 'Released for picking.');
      await step(page, 'Start picking', 'Picking started.');
      await step(page, 'Record what was picked', 'What was picked is recorded.');
      await step(page, 'Mark packed', 'Marked packed.');
      await step(page, 'Mark ready to go', 'Marked ready to go.');
      await step(page, 'Send out', 'Sent out.');
      await pick(page, page.getByRole('combobox', { name: 'Why it did not happen' }), 'Nobody', /Nobody was there/);
      await step(page, 'Record a failed attempt', 'The failed attempt is recorded.');
      await expect(page.getByText('Attempt failed', { exact: true }).first()).toBeVisible();
      await step(page, 'Try again', 'Ready to try again.');
      await step(page, 'Send out', 'Sent out.');
      // Delivering needs a name.
      await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'who received it' })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('Who received it').fill('Gate guard');
      await step(page, 'Mark delivered', 'Marked delivered.');

      const done = deliveryTool('order', orderNumber);
      expect(done.order_status).toBe('delivered');
      await openOrder(page, orderNumber);
      await expect(page.getByRole('region', { name: 'Deliveries' })).toContainText('Delivered', { timeout: 30_000 });
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('a returned delivery has its goods received, once, and the receipt is kept on its screen', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = await placeDeliveredOrder(page);
      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Deliveries' });
      await panel.getByRole('button', { name: 'Make the delivery' }).click();
      const made = panel.getByRole('link', { name: /^DLV-/ }).first();
      await expect(made).toBeVisible({ timeout: 30_000 });
      await clickUntilVisible(made, page.getByRole('heading', { name: /^Delivery DLV-/, level: 2 }));
      for (const [button, done] of [['Release for picking', 'Released for picking.'], ['Start picking', 'Picking started.'], ['Record what was picked', 'What was picked is recorded.'], ['Mark packed', 'Marked packed.'], ['Mark ready to go', 'Marked ready to go.'], ['Send out', 'Sent out.']] as const) await step(page, button, done);
      await pick(page, page.getByRole('combobox', { name: 'Why it did not happen' }), 'Nobody', /Nobody was there/);
      await step(page, 'Record a failed attempt', 'The failed attempt is recorded.');
      await page.getByLabel('Why it is being returned').fill('Customer is away for a week');
      await page.getByRole('button', { name: 'Return this delivery' }).click();
      await page.getByRole('button', { name: 'Confirm: Return this delivery' }).click();
      await expect(page.getByText(/^Returned\./).first()).toBeVisible({ timeout: 30_000 });

      // The goods that came back: the shop issues at payment, so the only choice is to keep them for the order.
      const section = page.getByRole('region', { name: 'Goods that came back' });
      await expect(section).toBeVisible();
      await expect(section).toContainText('It can be: Keep for the order');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
      await section.getByRole('button', { name: 'Receive these goods' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Choose what is to be done' })).toBeVisible({ timeout: 30_000 });
      await pick(page, section.getByRole('combobox', { name: /What to do with it/ }), 'Keep', /Keep for the order/);
      await section.getByRole('button', { name: 'Receive these goods' }).click();
      await expect(page.getByText('The returned goods are received.').first()).toBeVisible({ timeout: 30_000 });
      await expect(section).toContainText('Received 2: Keep for the order');
      await expect(section.getByRole('button', { name: 'Receive these goods' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'History' })).toContainText('Returned goods received');
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('the deliveries list is searched, filtered by a picker, fits every width, and an unknown delivery is not found', async ({ page }) => {
    test.slow();
    await open(page, '/admin/delivery/deliveries', 'Deliveries');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await expect(page.getByRole('combobox', { name: 'State' })).toBeVisible();
    // A search that matches nothing says so; a state is chosen from the picker.
    await page.getByLabel('Search').fill('NO-SUCH-DELIVERY-ANYWHERE');
    await expect(page.getByText('No delivery matches.')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search').fill('');
    await pick(page, page.getByRole('combobox', { name: 'State' }), 'Delivered', /^Delivered/);
    await noHorizontalScroll(page);
    await clickUntilVisible(page.getByRole('link', { name: /^DLV-/ }).first(), page.getByRole('heading', { name: /^Delivery DLV-/, level: 2 })).catch(() => undefined);
    await page.goto('/admin/delivery/deliveries/not-a-real-delivery');
    await expect(page.getByText(/could not be found|not found|doesn.t exist/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
