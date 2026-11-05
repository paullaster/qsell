import { expect, type Page } from '@playwright/test';
import { open } from './page';
import { deliveryTool } from './delivery-fixtures';

/** Two packets of salt in the cart, so the order can be delivered in two parts. */
export async function cartWithTwoSalt(page: Page): Promise<void> {
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
export async function placeDeliveredOrder(page: Page, options: { pay?: boolean } = {}): Promise<string> {
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
  if (options.pay !== false) deliveryTool('pay', orderNumber ?? '');
  return orderNumber ?? '';
}

export async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(orderNumber);
  const manage = page.getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await manage.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
}

/** Presses a step and waits for the delivery to say it is done. */
export async function step(page: Page, button: string, done: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByText(done).first()).toBeVisible({ timeout: 30_000 });
}

