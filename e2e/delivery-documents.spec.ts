import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { stockTool } from './support/stock-fixtures';

/** Two packets of salt in the cart, so the order can be delivered in two parts. */
async function cartWithTwoSalt(page: Page): Promise<void> {
  await page.goto('/?q=Salt 500g');
  const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await add.click();
  await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('2', { timeout: 15_000 });
}

/** The shopper has two packets delivered to a written area; the order is placed (a payment cannot finish in the test shop) and then paid. */
async function placeDeliveredOrder(page: Page, settle = false): Promise<string> {
  await cartWithTwoSalt(page);
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Full name').fill('Wanjiru Documents');
  await page.getByLabel('Mobile phone').fill('0711 000 666');
  await page.getByLabel('Street, building or office').fill('1 Moi Avenue');
  await page.getByLabel('City or town').fill('Nairobi');
  await page.getByLabel('County or region').fill('Nairobi');
  await page.getByLabel(/Estate or area/).fill('Westlands');
  const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
  await expect(section.getByRole('status').filter({ hasText: 'Delivery from' })).toContainText('348', { timeout: 30_000 });
  await page.getByLabel(/number to pay from$/).fill('0733 555 666');
  await page.getByRole('button', { name: /^Pay / }).click();
  const failed = page.getByRole('region', { name: 'Payment not completed' });
  const waiting = page.getByRole('region', { name: 'Waiting for payment' });
  await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
  const text = await page.locator('main, body').first().innerText();
  const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1];
  expect(orderNumber, 'the page names the order').toBeTruthy();
  if (settle) deliveryTool('pay', orderNumber ?? '', 'settle');
  else deliveryTool('pay', orderNumber ?? '');
  return orderNumber ?? '';
}

async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(orderNumber);
  const manage = page.getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await manage.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
}

/** Presses a step and waits for the delivery to say it is done. */
async function step(page: Page, button: string, done: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByText(done).first()).toBeVisible({ timeout: 30_000 });
}

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

  test('with stock kept by location and issued as a delivery goes out, the shelf moves with the delivery, the shop is not misled, and returned goods go back on the shelf', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      stockTool('ledger', 'on');
      stockTool('stockup', 'Salt 500g', '100');
      await open(page, '/admin/delivery/stock', 'Stock timing');
      await pick(page, page.getByRole('combobox', { name: 'The stock of a delivered order leaves the shelf' }), 'goes out', /When a delivery goes out/);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/^Saved\./)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('In use now:')).toContainText('When a delivery goes out');

      const shelf = () => Number(stockTool('onhand', 'Salt 500g').quantity);
      const shop = () => Number(stockTool('shopsees', 'Salt 500g').available);
      const before = shelf();
      const shopBefore = shop();

      // Paid, but not sent: the packets stay on the shelf, and the shop does not offer them.
      const orderNumber = await placeDeliveredOrder(page, true);
      expect(shelf()).toBe(before);
      expect(shop()).toBe(shopBefore - 2);

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
      await expect(section).toContainText('It can be: Back on the shelf, Damaged or spoilt');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await pick(page, section.getByRole('combobox', { name: /What to do with it/ }), 'shelf', /Back on the shelf/);
      await section.getByRole('button', { name: 'Receive these goods' }).click();
      await expect(page.getByText('The returned goods are received.').first()).toBeVisible({ timeout: 30_000 });
      await expect(section).toContainText('Received 1: Back on the shelf');
      expect(shelf()).toBe(before);
      expect(shop()).toBe(shopBefore - 2);

      // The order's timeline says so.
      await openOrder(page, orderNumber);
      await expect(page.getByRole('dialog')).toContainText('Returned to stock');
    } finally {
      stockTool('timing', 'payment');
      stockTool('ledger', 'off');
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
