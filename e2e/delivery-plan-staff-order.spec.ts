import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';

test.describe('an order taken by staff gets its delivery planned', () => {
  test('an order with no delivery plan is offered one on its screen, refused in words when it is not enough, and then is delivered like any other', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = deliveryTool('unplanned-order', tag).orderNumber ?? '';
      await open(page, '/admin/orders', /Web Shop Orders/);
      await page.getByLabel('Search orders').fill(orderNumber);
      const manage = page.getByRole('link', { name: /Open order/ }).first();
      await expect(manage).toBeVisible({ timeout: 60_000 });
      await manage.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 30_000 });

      // Not planned at a checkout: the screen says so and offers to plan it, starting from the address the order was taken with.
      const plan = dialog.getByRole('region', { name: 'Plan the delivery' });
      await expect(plan).toBeVisible({ timeout: 30_000 });
      await expect(plan).toContainText('7 Kimathi Street');
      await expect(plan.getByLabel('Town or city')).toHaveValue('Nairobi');
      await expect(dialog.getByRole('region', { name: 'Deliveries' })).toHaveCount(0);
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);

      // Nowhere to go, or half a receiver, is refused in words and nothing is planned.
      await plan.getByLabel('Town or city').fill('');
      await plan.getByLabel('County or region').fill('');
      await plan.getByRole('button', { name: 'Plan the delivery' }).click();
      await expect(plan.getByRole('alert')).toContainText('town or area', { timeout: 30_000 });
      await plan.getByLabel('Town or city').fill('Nairobi');
      await plan.getByLabel('Who receives it (optional)').fill('Mama Wanjiku');
      await plan.getByRole('button', { name: 'Plan the delivery' }).click();
      await expect(plan.getByRole('alert')).toContainText('both the name and the phone', { timeout: 30_000 });

      // Planned: the form is gone and the order has its deliveries section, so a delivery can be made from it.
      await plan.getByLabel('Their phone').fill('0722 111 222');
      await plan.getByRole('button', { name: 'Plan the delivery' }).click();
      await expect(dialog.getByRole('region', { name: 'Deliveries' })).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByRole('region', { name: 'Plan the delivery' })).toHaveCount(0);
      expect(deliveryTool('order', orderNumber)).toMatchObject({ method: 'own_fleet', recipient_name: 'Mama Wanjiku', ship_street: '7 Kimathi Street' });
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
