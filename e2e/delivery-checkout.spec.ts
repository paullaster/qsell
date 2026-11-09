import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
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

test.describe('delivery at the shop checkout', () => {
  test('the shopper gives a place, sees the branch and the charge with its tax before paying, and the order carries exactly that', async ({ page, context }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const branchName = deliveryTool('open', tag).branchName ?? '';
    try {
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation({ latitude: -1.2921, longitude: 36.8219 });
      await cartWithSalt(page);
      await page.goto('/checkout');
      await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
      const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
      await expect(section).toBeVisible({ timeout: 30_000 });
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await expect(section).toContainText('Drop a pin or write your area');

      await page.getByLabel('Full name').fill('Wanjiru Deliver');
      await page.getByLabel('Mobile phone').fill('0711 000 444');
      await page.getByLabel('Street, building or office').fill('1 Moi Avenue');

      // A written area is enough: the nearest branch that can deliver it, its charge, and the tax on it, before any payment.
      await page.getByLabel('City or town').fill('Nairobi');
      await page.getByLabel('County or region').fill('Nairobi');
      await page.getByLabel(/Estate or area/).fill('Westlands');
      await expect(section.getByRole('status').filter({ hasText: `Delivery from ${branchName}` })).toContainText('348', { timeout: 30_000 });
      await expect(section).toContainText('Includes');
      await expect(section).toContainText('(16%)');
      const summary = page.getByRole('complementary', { name: 'Order summary' });
      await expect(summary).toContainText(`Delivery from ${branchName}`);
      await expect(summary).toContainText('348');
      await section.getByText('How this was worked out').click();
      await expect(section.getByRole('listitem').first()).toBeVisible();

      // The device's location makes it a pin, and the charge is asked again; someone else can receive it.
      await section.getByRole('button', { name: 'Use my location' }).click();
      await expect(section.getByRole('button', { name: 'Remove the pin' })).toBeVisible({ timeout: 30_000 });
      await expect(section.getByRole('status').filter({ hasText: `Delivery from ${branchName}` })).toContainText('348', { timeout: 30_000 });
      await section.getByLabel('Someone else will receive the order').check();
      await page.getByRole('button', { name: /^Pay / }).click();
      await expect(page.locator('form').getByRole('alert').first()).toContainText('name and mobile number of the person who will receive');
      await section.getByLabel('Their name').fill('Mama Wanjiku');
      await section.getByLabel('Their mobile number').fill('0722 111 222');
      await section.getByLabel('Note for the rider (optional)').fill('Blue gate, ask for the guard');
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);

      // Paying places the order (the test shop has no bank behind it, so the payment itself cannot finish).
      await page.getByLabel(/number to pay from$/).fill('0733 555 666');
      await page.getByRole('button', { name: /^Pay / }).click();
      const failed = page.getByRole('region', { name: 'Payment not completed' });
      const waiting = page.getByRole('region', { name: 'Waiting for payment' });
      await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
      const text = await page.locator('main, body').first().innerText();
      const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1];
      expect(orderNumber, 'the page names the order').toBeTruthy();

      const kept = deliveryTool('order', orderNumber ?? '');
      expect(kept.branch).toBe(branchName);
      // What the shopper was shown is what the order carries: 300 plus 48 tax, the tax inside the order's tax, the total adding up.
      expect(Number(kept.charge_amount)).toBe(348);
      expect(Number(kept.charge_net)).toBe(300);
      expect(Number(kept.charge_tax)).toBe(48);
      expect(Number(kept.tax_rate)).toBe(16);
      expect(Number(kept.shipping_fee)).toBe(300);
      expect(Math.round((Number(kept.subtotal) + Number(kept.tax) + Number(kept.shipping_fee)) * 100) / 100).toBe(Number(kept.total_amount));
      expect(Number(kept.tax)).toBeGreaterThanOrEqual(48);
      expect(kept.recipient_name).toBe('Mama Wanjiku');
      expect(kept.recipient_phone).toBe('254722111222');
      expect(kept.notes).toBe('Blue gate, ask for the guard');
      expect(kept.stages).toContain('charge_quoted');

      // Staff see the order's delivery invoice only when the company bills delivery on an invoice of its own.
      const openOrder = async (): Promise<void> => {
        await open(page, '/admin/orders', /Customer Orders/);
        await page.getByLabel('Search orders').fill(orderNumber ?? '');
        const manage = page.getByRole('button', { name: /Manage/ }).first();
        await expect(manage).toBeVisible({ timeout: 60_000 });
        await manage.click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
      };
      deliveryTool('billing', 'with_goods');
      await openOrder();
      const invoices = page.getByRole('group', { name: 'Invoices' });
      await expect(invoices.getByRole('button', { name: 'Tax Invoice PDF' })).toBeVisible();
      await expect(invoices.getByRole('button', { name: 'Delivery Invoice PDF' })).toHaveCount(0);
      deliveryTool('billing', 'separate');
      await openOrder();
      await expect(invoices.getByRole('button', { name: 'Delivery Invoice PDF' })).toBeVisible({ timeout: 30_000 });
      await expect(invoices.getByRole('button', { name: 'Email Delivery Invoice' })).toBeVisible();
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('billing', 'reset');
      deliveryTool('close', tag);
    }
  });

  test('the shopper is shown the delivery times, chooses one, and the order keeps it and has it booked when the delivery is made', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const branchName = deliveryTool('open', tag).branchName ?? '';
    const slotName = deliveryTool('slot', tag).name ?? '';
    try {
      await cartWithSalt(page);
      await page.goto('/checkout');
      await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
      const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
      await expect(section).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('Full name').fill('Wanjiru Timed');
      await page.getByLabel('Mobile phone').fill('0711 000 555');
      await page.getByLabel('Street, building or office').fill('2 Moi Avenue');
      await page.getByLabel('City or town').fill('Nairobi');
      await page.getByLabel('County or region').fill('Nairobi');
      await page.getByLabel(/Estate or area/).fill('Westlands');
      await expect(section.getByRole('status').filter({ hasText: `Delivery from ${branchName}` })).toContainText('348', { timeout: 30_000 });

      // The times come with the price: the earliest first, a choice is optional, and a time can be taken back.
      const times = section.getByRole('group', { name: /When would you like it/ });
      await expect(times).toBeVisible({ timeout: 30_000 });
      await expect(times).toContainText('Earliest:');
      await expect(times.getByLabel('No preference')).toBeChecked();
      await noNativeSelect(page);
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);
      await times.getByRole('button', { name: 'Choose this time' }).click();
      await expect(times.getByRole('button', { name: 'Chosen' })).toBeDisabled();
      await expect(times.getByLabel('No preference')).not.toBeChecked();
      await times.getByLabel('No preference').click();
      await expect(times.getByLabel('No preference')).toBeChecked();
      await times.getByRole('button', { name: 'Choose this time' }).click();
      await expect(times.getByRole('button', { name: 'Chosen' })).toBeVisible();

      await page.getByLabel(/number to pay from$/).fill('0733 555 777');
      await page.getByRole('button', { name: /^Pay / }).click();
      const failed = page.getByRole('region', { name: 'Payment not completed' });
      const waiting = page.getByRole('region', { name: 'Waiting for payment' });
      await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
      const text = await page.locator('main, body').first().innerText();
      const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1] ?? '';
      expect(orderNumber, 'the page names the order').toBeTruthy();

      // The order keeps the choice; the delivery, when it is made, holds the slot.
      expect(deliveryTool('slot-request', orderNumber)).toMatchObject({ outcome: 'pending', slot: slotName });
      deliveryTool('pay', orderNumber);
      deliveryTool('ready', orderNumber, 'draft');
      expect(deliveryTool('slot-request', orderNumber)).toMatchObject({ outcome: 'booked', slot: slotName });
      expect(deliveryTool('slot-request', orderNumber).booked_day).toBe(deliveryTool('slot-request', orderNumber).day);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
