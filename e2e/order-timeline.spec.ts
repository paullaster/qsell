import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, open } from './support/page';
import { pick } from './support/quotes';
import { latestAttempt, makeProduct, orderStages, setStock } from './support/storefront-fixtures';
import { attemptTag } from './support/vendors';

/** Puts a product in the cart and opens the checkout with the details filled in, ready to press pay. */
async function readyToPay(page: Page, productName: string): Promise<void> {
  await page.goto(`/?q=${productName}`);
  const add = page.getByRole('button', { name: `Add ${productName} to cart` });
  await expect(add).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Full name').fill('Wanjiru Timeline');
  await page.getByLabel('Mobile phone').fill('0711 000 444');
  await page.getByLabel('Street, building or office').fill('1 Moi Avenue');
  await page.getByLabel('City or town').fill('Nairobi');
}

/** Finds an order in the admin list and opens it for work. */
async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(orderNumber);
  const manage = page.getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await manage.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
}

test.describe('every stage of an order is timestamped, failures included', () => {
  test('a checkout that is refused leaves a trace with its stage and reason, and the order flow shows it', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const productName = makeProduct(tag);
    await readyToPay(page, productName);
    // Someone else buys the last stock while this shopper is typing.
    setStock(`prod_rv_${tag}`, 0);
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.locator('form').getByRole('alert')).toContainText(/Insufficient inventory|not enough|sold out/i, { timeout: 60_000 });
    // It is on record with its time, where it stopped and why, and the guest is only a hash.
    await expect.poll(() => latestAttempt().outcome, { timeout: 30_000 }).toBe('refused');
    const attempt = latestAttempt();
    expect(attempt).toMatchObject({ stage: 'placement', reason: 'stock_short', hasSession: true, finished: true });
    expect(attempt.message).toMatch(/Insufficient inventory/);

    // The people who watch orders see it in the order flow.
    await open(page, '/admin/orders', /Customer Orders/);
    const flow = page.getByLabel('Order flow');
    await expect(flow).toBeVisible({ timeout: 60_000 });
    await flow.getByText(/Order flow, last 7 days/).click();
    await expect(flow.getByText(/Not enough stock/).first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('an order whose payment could not be started is saved with every stage, and staff see them with their times and the reason', async ({ page }, testInfo) => {
    // Place an order, open it as staff, move it, then track it as the shopper: four screens on a development server that compiles as it goes.
    test.setTimeout(720_000);
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const productName = makeProduct(tag);
    await readyToPay(page, productName);
    await page.getByRole('button', { name: /^Pay / }).click();
    const failed = page.getByRole('region', { name: 'Payment not completed' });
    const waiting = page.getByRole('region', { name: 'Waiting for payment' });
    await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
    const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(await page.locator('body').innerText())?.[1] ?? '';
    expect(orderNumber, 'the page names the order').not.toBe('');

    // On record: placed (by the shop), then the payment, each in order.
    const recorded = orderStages(orderNumber);
    expect(recorded.stages[0]).toBe('order_placed:succeeded');
    expect(recorded.sources[0]).toBe('shop');
    expect(recorded.stages.some((s) => s.startsWith('payment_started:'))).toBe(true);
    expect(recorded.stages.every((s) => !s.startsWith('unrecorded_change'))).toBe(true);
    expect(latestAttempt()).toMatchObject({ outcome: 'placed' });

    // Staff open the order and see the timeline: every stage, its time, and what went wrong.
    await openOrder(page, orderNumber);
    const timeline = page.getByRole('region', { name: 'Order timeline' });
    await expect(timeline.getByText('Order placed')).toBeVisible({ timeout: 30_000 });
    await expect(timeline.locator('time').first()).toBeVisible();
    if (recorded.stages.includes('payment_started:failed')) {
      const item = timeline.locator('li[data-stage="payment_started"][data-outcome="failed"]');
      await expect(item).toBeVisible();
      await expect(item).toContainText('The payment could not be started');
    }
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // An administrator moves it along: the stage is recorded with its time, and it is shown at once.
    const dialog = page.getByRole('dialog');
    await pick(page, dialog.getByRole('combobox', { name: 'Update Status' }), 'Dispatched', /Dispatched \/ in transit/);
    await dialog.getByRole('button', { name: 'Save Fulfillment Changes' }).click();
    await expect.poll(() => orderStages(orderNumber).stages.at(-1), { timeout: 30_000 }).toBe('dispatched:succeeded');
    expect(orderStages(orderNumber)).toMatchObject({ current: 'dispatched', status: 'shipped' });
    await page.keyboard.press('Escape');
    await openOrder(page, orderNumber);
    await expect(page.getByRole('region', { name: 'Order timeline' }).locator('li[data-stage="dispatched"]')).toBeVisible({ timeout: 30_000 });

    // The shopper's own tracking shows only the plain stages, with times, and no staff detail.
    await page.keyboard.press('Escape');
    await page.goto('/');
    await page.getByRole('button', { name: 'Track my order' }).click();
    const tracker = page.getByRole('dialog', { name: /Track your order/ });
    await expect(tracker).toBeVisible({ timeout: 30_000 });
    await tracker.getByLabel('Order number').fill(orderNumber);
    await tracker.getByLabel('Email or phone used at checkout').fill('0711 000 444');
    await tracker.getByRole('button', { name: 'Track Order' }).click();
    const progress = page.getByRole('list', { name: 'Order progress' });
    await expect(progress).toBeVisible({ timeout: 60_000 });
    await expect(progress.getByText('Order placed')).toBeVisible();
    await expect(progress.getByText('On its way')).toBeVisible();
    await expect(progress).not.toContainText(/could not be started|failed|reason/i);
  });
});
