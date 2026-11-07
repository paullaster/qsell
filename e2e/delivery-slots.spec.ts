import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder } from './support/delivery-shop';

const dayAhead = (days: number): string => new Date(Date.now() + days * 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);

test.describe('delivery slots', () => {
  test('a branch gets a slot with room for one a day, a delivery is promised it, and the next delivery finds it full', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      await open(page, '/admin/delivery/slots', 'Delivery slots');
      await noNativeSelect(page);

      // A slot is refused until it makes sense.
      const form = page.getByRole('form', { name: 'Add a slot' });
      await pick(page, form.getByRole('combobox', { name: 'Branch' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await form.getByLabel('Name').fill('Morning');
      await form.getByLabel('Starts (Nairobi)').fill('12:00');
      await form.getByLabel('Ends (Nairobi)').fill('09:00');
      await form.getByLabel('Deliveries a day').fill('1');
      await form.getByLabel('Closes (minutes before)').fill('0');
      for (const day of ['Sat', 'Sun']) await form.getByRole('checkbox', { name: day }).check();
      await form.getByRole('button', { name: 'Add the slot' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'The slot must end after it starts.' })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('Starts (Nairobi)').fill('09:00');
      await form.getByLabel('Ends (Nairobi)').fill('23:00');
      await form.getByRole('button', { name: 'Add the slot' }).click();
      await expect(page.getByText('The slot is added.')).toBeVisible({ timeout: 30_000 });
      const row = page.getByRole('list', { name: 'Slot list' }).getByRole('listitem').filter({ hasText: `Morning · Delivery ${tag}` }).first();
      await expect(row).toContainText('Every day');
      await expect(row).toContainText('room for 1 a day');

      // A day with no slots, for this branch.
      const closing = page.getByRole('form', { name: 'Close a day' });
      await closing.getByLabel('Day').fill(dayAhead(5));
      await pick(page, closing.getByRole('combobox', { name: 'Branch (all if empty)' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await closing.getByLabel('Why').fill('Stocktake');
      await closing.getByRole('button', { name: 'Close the day' }).click();
      await expect(page.getByText('The day is closed: no slot is offered on it.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('list', { name: 'Closed day list' })).toContainText('Stocktake');
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // Two deliveries from that branch: the first is promised a slot; the second finds the place taken.
      const firstOrder = await placeDeliveredOrder(page);
      const first = deliveryTool('ready', firstOrder).number ?? '';
      const secondOrder = await placeDeliveredOrder(page);
      const second = deliveryTool('ready', secondOrder).number ?? '';

      await open(page, '/admin/delivery/deliveries', 'Deliveries');
      await page.getByRole('link', { name: first }).first().click();
      const panel = page.getByRole('region', { name: 'Delivery slot' });
      await expect(panel).toBeVisible({ timeout: 90_000 });
      await expect(panel).toContainText('No slot is promised for this delivery yet.', { timeout: 30_000 });
      await expect(panel).toContainText('Closed: Stocktake');
      const choice = panel.getByRole('button', { name: /^Book Morning/ }).and(panel.locator(':not([disabled])')).first();
      await expect(choice).toBeVisible({ timeout: 30_000 });
      await choice.click();
      await expect(page.getByText('The slot is promised to the customer.')).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText('Promised', { timeout: 30_000 });
      await expect(panel).toContainText('Morning:');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      await open(page, '/admin/delivery/deliveries', 'Deliveries');
      await page.getByRole('link', { name: second }).first().click();
      const again = page.getByRole('region', { name: 'Delivery slot' });
      await expect(again).toContainText('No slot is promised for this delivery yet.', { timeout: 90_000 });
      const full = again.getByRole('button', { name: /This slot is full that day/ }).first();
      await expect(full).toBeVisible({ timeout: 30_000 });
      await expect(full).toBeDisabled();
    } finally {
      deliveryTool('close', tag);
    }
  });
});
