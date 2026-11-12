import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';

async function cartWithSalt(page: Page): Promise<void> {
  await page.goto('/?q=Salt 500g');
  const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

/** The shopper chooses to collect from the test branch, places the order (the test shop cannot finish a payment), and returns its number. */
async function placeCollectedOrder(page: Page, branchName: string, email: string): Promise<string> {
  await cartWithSalt(page);
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
  const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.getByRole('radio', { name: 'Collect from a branch' }).check();

  // The delivery address goes away; the branches that can be collected from are offered, each with where it is and how soon it is ready.
  await expect(page.getByLabel('Street, building or office')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Collection', level: 2 })).toBeVisible();
  const picker = page.getByRole('group', { name: 'Where to collect your order' });
  const branch = picker.getByRole('radio', { name: new RegExp(branchName) });
  await expect(branch).toBeVisible({ timeout: 30_000 });
  await expect(picker).toContainText('Ready: 30 minutes');
  await noNativeSelect(page);
  await noHorizontalScroll(page);
  await noInnerHorizontalScroll(page);
  await page.getByLabel('Full name').fill('Wanjiru Collect');
  await page.getByLabel('Mobile phone').fill('0711 000 555');
  await page.getByLabel('Email (optional)').fill(email);

  // Nothing can be placed until a branch is chosen; then it is free, and the summary says so.
  await page.getByRole('button', { name: /^Pay / }).click();
  await expect(page.locator('form').getByRole('alert').first()).toContainText('Choose the branch you will collect from');
  await branch.check();
  await expect(picker.getByRole('status').filter({ hasText: `Collect from ${branchName}` })).toContainText('free', { timeout: 30_000 });
  const summary = page.getByRole('complementary', { name: 'Order summary' });
  await expect(summary).toContainText(`Collect from ${branchName}`);
  await expect(summary).toContainText('Free');

  await page.getByLabel(/number to pay from$/).fill('0733 555 666');
  await page.getByRole('button', { name: /^Pay / }).click();
  const failed = page.getByRole('region', { name: 'Payment not completed' });
  const waiting = page.getByRole('region', { name: 'Waiting for payment' });
  await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
  const text = await page.locator('main, body').first().innerText();
  const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1];
  expect(orderNumber, 'the page names the order').toBeTruthy();
  return orderNumber ?? '';
}

/** The customer looks their order up the way anyone can, with its number and the contact it was placed with. */
async function trackOrder(page: Page, orderNumber: string, email: string): Promise<void> {
  await page.goto('/');
  // The footer's button is there at every width; the header's is in a menu on a phone.
  await clickUntilVisible(page.getByRole('button', { name: 'Track my order' }), page.getByRole('dialog', { name: 'Track your order' }));
  const dialog = page.getByRole('dialog', { name: 'Track your order' });
  await dialog.getByLabel('Order number').fill(orderNumber);
  await dialog.getByLabel('Email or phone used at checkout').fill(email);
  await dialog.getByRole('button', { name: /Track|Find|Search/i }).last().click();
}

/** Finds an order in the admin list and opens it for work. */
async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(orderNumber);
  const manage = page.getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  // The list can be drawn before its buttons are wired up, and a click in that moment does nothing.
  await clickUntilVisible(manage, page.getByRole('dialog'));
}

const shown = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`;

test.describe('collecting an order from a branch', () => {
  test('the shopper chooses a branch and pays nothing for collecting; the order carries a code the customer can find, and the counter hands it over once', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const email = `collect-${tag.toLowerCase()}@example.test`;
    const branchName = deliveryTool('open', tag).branchName ?? '';
    try {
      const orderNumber = await placeCollectedOrder(page, branchName, email);

      // What was saved: collection from the chosen branch, nothing charged, a code that is waiting.
      const kept = deliveryTool('order', orderNumber);
      expect(kept.method).toBe('pickup');
      expect(kept.branch).toBe(branchName);
      expect(Number(kept.charge_amount)).toBe(0);
      expect(Number(kept.shipping_fee)).toBe(0);
      const made = deliveryTool('collection', orderNumber);
      expect(made.status).toBe('waiting');
      expect(made.code).toMatch(/^[A-Z2-9]{6}$/);
      const code = made.code ?? '';

      // The order has not been paid for, so the counter will not hand it over; once the money arrives, it can be.
      deliveryTool('pay', orderNumber);

      // The customer finds where to collect and the code, by the order number and the email it was placed with.
      await trackOrder(page, orderNumber, email);
      const mine = page.getByRole('region', { name: 'Collect your order' });
      await expect(mine).toBeVisible({ timeout: 30_000 });
      await expect(mine).toContainText(branchName);
      await expect(mine).toContainText(shown(code));
      await expect(mine).toContainText('getting your order ready');
      await noHorizontalScroll(page);

      // The counter: mark it ready, refuse a wrong code (and count the try), then hand over with the right one, typed any way.
      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Collection' });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText(branchName);
      await expect(panel).toContainText('Waiting to be prepared');
      await expect(panel).not.toContainText(code);
      await panel.getByRole('button', { name: 'Mark ready for collection' }).click();
      await expect(panel.getByText('Marked ready for collection.')).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('Ready, waiting for the customer');
      // The customer is told, and the counter can see it was: the mail to them is listed, without the code.
      await expect(panel.getByRole('list', { name: 'Messages to the customer' })).toContainText('Ready to collect (email)', { timeout: 30_000 });
      await expect(panel.getByRole('list', { name: 'Messages to the customer' })).not.toContainText(shown(code));

      const wrong = code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
      await panel.getByLabel('Code the customer shows').fill(wrong);
      await panel.getByRole('button', { name: 'Hand over', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('not the code for this order', { timeout: 30_000 });
      await expect(panel.getByRole('alert')).toContainText('4 tries left');
      expect(deliveryTool('collection', orderNumber)).toMatchObject({ status: 'ready', attempts: '1' });
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      await panel.getByLabel('Code the customer shows').fill(shown(code).toLowerCase());
      await panel.getByRole('button', { name: 'Hand over', exact: true }).click();
      await expect(panel.getByText('Handed over to the customer.')).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('Collected');
      await expect(panel.getByLabel('Code the customer shows')).toHaveCount(0);
      expect(deliveryTool('collection', orderNumber)).toMatchObject({ status: 'collected', how: 'code', orderStatus: 'delivered', code: '' });

      // The customer sees it is collected, and the code is gone: it works once.
      await trackOrder(page, orderNumber, email);
      const after = page.getByRole('region', { name: 'Collect your order' });
      await expect(after).toContainText('You have collected this order', { timeout: 30_000 });
      await expect(after).not.toContainText(shown(code));
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('without a code, a person allowed to may hand the order over after an ID check, saying what was seen and why', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const email = `idcheck-${tag.toLowerCase()}@example.test`;
    const branchName = deliveryTool('open', tag).branchName ?? '';
    try {
      const orderNumber = await placeCollectedOrder(page, branchName, email);
      deliveryTool('pay', orderNumber);
      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Collection' });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await panel.getByText('The customer has no code, or it is locked').click();

      // Both what was seen and why are needed, and the person confirms before it is done.
      const confirm = panel.getByRole('button', { name: /^Confirm: Hand over after an ID check/ });
      await clickUntilVisible(panel.getByRole('button', { name: 'Hand over after an ID check', exact: true }), confirm);
      await confirm.click();
      await expect(panel.getByRole('alert')).toContainText('Say what ID you saw', { timeout: 30_000 });
      await panel.getByLabel('ID you saw').fill('National ID ending 4321');
      await clickUntilVisible(panel.getByRole('button', { name: 'Hand over after an ID check', exact: true }), confirm);
      await confirm.click();
      await expect(panel.getByRole('alert')).toContainText('Say why the code was not used', { timeout: 30_000 });
      await panel.getByLabel('Why (kept with the hand-over)').fill('The customer lost the phone with the code');
      await clickUntilVisible(panel.getByRole('button', { name: 'Hand over after an ID check', exact: true }), confirm);
      await confirm.click();
      await expect(panel.getByText('Handed over after an ID check.')).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('after an ID check');
      expect(deliveryTool('collection', orderNumber)).toMatchObject({ status: 'collected', how: 'id_check', orderStatus: 'delivered' });
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('the shop does not offer collection when no branch offers it, and checkout asks for an address as before', async ({ page }) => {
    // The branches the other tests made are switched off again, so none offers collection.
    await cartWithSalt(page);
    await page.goto('/checkout');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('radio', { name: 'Collect from a branch' })).toHaveCount(0);
    await expect(page.getByLabel('Street, building or office')).toBeVisible();
  });
});
