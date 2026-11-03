import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { openOrder, placeDeliveredOrder, step } from './support/delivery-shop';

test.describe('what the customer is told and shown', () => {
  test('a delivery sends the customer a message and a tracking link that shows only their order, can be replaced, and has a note to print', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const email = `tracking-${tag.toLowerCase()}@example.test`;
    deliveryTool('open', tag);
    try {
      const orderNumber = await placeDeliveredOrder(page);
      deliveryTool('set-email', orderNumber, email);
      const made = deliveryTool('ready', orderNumber);
      const number = made.number ?? '';

      // The delivery goes out: the customer is told, once, and the shop can see that they were.
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await step(page, 'Send out', 'Sent out.');
      await expect.poll(() => deliveryTool('messages', orderNumber).list, { timeout: 60_000 }).toBe('out_for_delivery:sent');
      await page.reload();
      const log = page.getByRole('region', { name: 'Messages to the customer' });
      await expect(log).toContainText('On its way', { timeout: 30_000 });
      await expect(log).toContainText('Sent');
      await expect(log).toContainText('t***@example.test');
      await expect(log).not.toContainText(email);

      // The delivery note is a PDF while the delivery is out, and the link to it is on the screen.
      await expect(page.getByRole('link', { name: 'Download the delivery note (PDF)' })).toBeVisible();
      const note = await page.request.get(`/api/admin/delivery/deliveries/${made.id ?? ''}/note`);
      expect(note.status()).toBe(200);
      expect(note.headers()['content-type']).toBe('application/pdf');
      expect((await note.body()).subarray(0, 5).toString()).toBe('%PDF-');

      // The tracking link, on the order's own screen.
      await openOrder(page, orderNumber);
      const panel = page.getByRole('region', { name: 'Deliveries' });
      const url = await panel.getByRole('textbox', { name: 'Tracking link' }).inputValue({ timeout: 30_000 });
      expect(url).toMatch(/\/track\/[A-Za-z0-9_-]{32}$/);

      // Anyone with the link, signed in or not, sees the order in the customer's words, and nothing they should not.
      const visitor = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
      const guest = await visitor.newPage();
      try {
        await guest.goto(url);
        await expect(guest.getByRole('status').filter({ hasText: 'Your order is on its way to you' })).toBeVisible({ timeout: 60_000 });
        await expect(guest.getByText(number)).toBeVisible();
        await expect(guest.getByRole('list', { name: `Steps of ${number}` }).locator('[aria-current="step"]')).toHaveText('On its way');
        await noHorizontalScroll(guest);
        const shown = await guest.locator('main').last().innerText();
        expect(shown).not.toMatch(/Moi Avenue|0711|Westlands|KSh|dispatcher/i);
        expect(await guest.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
        // A link that is not ours is not found, and says nothing about orders.
        await guest.goto('/track/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        await expect(guest.getByText(/could not be found|not found|404/i).first()).toBeVisible({ timeout: 30_000 });
        await guest.goto('/track/short');
        await expect(guest.getByText(/could not be found|not found|404/i).first()).toBeVisible({ timeout: 30_000 });

        // The customer can find the same thing from "Track my order" with the number and the contact they used.
        await guest.goto('/');
        await clickUntilVisible(guest.getByRole('button', { name: 'Track my order' }), guest.getByRole('dialog', { name: 'Track your order' }));
        await guest.getByRole('dialog', { name: 'Track your order' }).getByLabel('Order number').fill(orderNumber);
        await guest.getByRole('dialog', { name: 'Track your order' }).getByLabel('Email or phone used at checkout').fill(email);
        const dialog = guest.getByRole('dialog', { name: 'Track your order' });
        await dialog.getByRole('button', { name: 'Track Order', exact: true }).click();
        await expect(dialog.getByText('Your order is on its way to you')).toBeVisible({ timeout: 60_000 });
        await expect(dialog.getByRole('link', { name: 'your tracking page' })).toHaveAttribute('href', url);
      } finally {
        await visitor.close();
      }

      // It is delivered: the customer is told again, and the page says so.
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await page.getByLabel('Who received it').fill('Mama Wanjiku');
      await step(page, 'Mark delivered', 'Marked delivered.');
      await expect.poll(() => deliveryTool('messages', orderNumber).list, { timeout: 60_000 }).toBe('out_for_delivery:sent,delivered:sent');
      const later = await browser.newContext();
      const again = await later.newPage();
      try {
        await again.goto(url);
        await expect(again.getByRole('status').filter({ hasText: 'Your order has been delivered' })).toBeVisible({ timeout: 60_000 });
        await expect(again.getByText('Received by Mama Wanjiku')).toBeVisible();
      } finally {
        await later.close();
      }

      // The link is replaced, with a reason: the old one stops working and the new one works.
      await openOrder(page, orderNumber);
      const links = page.getByRole('region', { name: 'Deliveries' });
      await links.getByLabel('Why the link is being replaced').fill('It was sent to the wrong person');
      await links.getByRole('button', { name: 'Make a new tracking link for this order' }).click();
      await links.getByRole('button', { name: 'Confirm: Make a new tracking link for this order' }).click();
      await expect.poll(async () => await links.getByRole('textbox', { name: 'Tracking link' }).inputValue(), { timeout: 30_000 }).not.toBe(url);
      const fresh = await links.getByRole('textbox', { name: 'Tracking link' }).inputValue();
      const check = await browser.newContext();
      const third = await check.newPage();
      try {
        await third.goto(url);
        await expect(third.getByText(/could not be found|not found|404/i).first()).toBeVisible({ timeout: 30_000 });
        await third.goto(fresh);
        await expect(third.getByRole('status').filter({ hasText: 'Your order has been delivered' })).toBeVisible({ timeout: 60_000 });
      } finally {
        await check.close();
      }
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
