import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder } from './support/delivery-shop';
import { riderTool } from './support/rider-fixtures';

test.describe('late deliveries', () => {
  test('a delivery past its promised window is raised, shown on the board and the late screen, and acknowledged with a note', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = await placeDeliveredOrder(page);
      const number = deliveryTool('ready', orderNumber).number ?? '';
      expect(riderTool('late', number).raised).toBe('3');

      // The dispatch board says what was promised and that it is late.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      const ready = page.getByRole('region', { name: 'Ready to go' });
      await expect(ready).toContainText(number, { timeout: 30_000 });
      await expect(ready).toContainText(/Promised .*Late/);

      await open(page, '/admin/delivery/late', 'Late deliveries');
      await noNativeSelect(page);
      const card = page.getByRole('list', { name: 'Late delivery list' }).getByRole('listitem').filter({ hasText: number }).first();
      await expect(card).toContainText('Late by', { timeout: 30_000 });
      await expect(card).toContainText('Still late: the supervisor is told');
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      const form = card.getByRole('form', { name: `Acknowledge ${number}` });
      await form.getByLabel('What is being done about it').fill('no');
      await form.getByRole('button', { name: 'Acknowledge' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Say what is being done about it' })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('What is being done about it').fill('Rider is on the way, customer called');
      await form.getByRole('button', { name: 'Acknowledge' }).click();
      await expect(page.getByText('Acknowledged.')).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('Rider is on the way, customer called', { timeout: 30_000 });
      await expect(card.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('the lateness settings are saved with words, and refused when they make no sense', async ({ page }) => {
    await open(page, '/admin/delivery/slots', 'Delivery slots');
    const form = page.getByRole('form', { name: 'Lateness' });
    await form.getByLabel('Tell the supervisor after this many minutes late').fill('0');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Tell the supervisor after this many minutes late' })).toBeVisible({ timeout: 30_000 });
    // The addresses mailed about lateness are checked, and kept.
    await form.getByLabel('Tell the supervisor after this many minutes late').fill('45');
    await form.getByLabel('Mail the dispatchers when a delivery is at risk or late').fill('dispatch@e2e.test, nobody');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '"nobody" is not a mail address' })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Mail the dispatchers when a delivery is at risk or late').fill('dispatch@e2e.test, Ops@e2e.test');
    await form.getByLabel('Mail the supervisors when it has been late too long').fill('boss@e2e.test');
    await form.getByLabel('At risk this many minutes before the window ends').fill('30');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. The Late deliveries screen uses these from now on.')).toBeVisible({ timeout: 30_000 });
    // Put back what it was so other tests are not held to these numbers.
    const again = page.getByRole('form', { name: 'Lateness' });
    await again.getByLabel('Tell the supervisor after this many minutes late').fill('60');
    await again.getByLabel('At risk this many minutes before the window ends').fill('60');
    await expect(again.getByLabel('Mail the dispatchers when a delivery is at risk or late')).toHaveValue('dispatch@e2e.test, ops@e2e.test');
    await expect(again.getByLabel('Mail the supervisors when it has been late too long')).toHaveValue('boss@e2e.test');
    await again.getByLabel('Mail the dispatchers when a delivery is at risk or late').fill('');
    await again.getByLabel('Mail the supervisors when it has been late too long').fill('');
    await again.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. The Late deliveries screen uses these from now on.').first()).toBeVisible({ timeout: 30_000 });
  });
});
