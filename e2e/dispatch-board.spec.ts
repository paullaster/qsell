import { expect, test } from '@playwright/test';
import { followLink, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder, step } from './support/delivery-shop';

const today = (): string => new Date().toISOString().slice(0, 10);

test.describe('the dispatch board', () => {
  test('two ready deliveries are put on a run, ordered, sent out together, and the run closes once each has a result', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const first = deliveryTool('ready', await placeDeliveredOrder(page)).number ?? '';
      const second = deliveryTool('ready', await placeDeliveredOrder(page)).number ?? '';
      expect(first).toMatch(/^DLV-/);

      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
      const ready = page.getByRole('region', { name: 'Ready to go' });
      await expect(ready).toContainText(first, { timeout: 30_000 });
      await expect(ready).toContainText(second);

      // Plan a run for the fixture's branch.
      const plan = page.getByRole('region', { name: 'Plan a run' });
      await pick(page, plan.getByRole('combobox', { name: 'Leaves from' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await plan.getByLabel('Day').fill(today());
      await plan.getByLabel('Or a name, for someone not using the app').fill('Otieno');
      await plan.getByLabel('Vehicle (optional)').fill('KMFA 123A');
      await plan.getByRole('button', { name: 'Plan the run' }).click();
      const planned = page.getByText(/^Run RUN-.* is planned/);
      await expect(planned).toBeVisible({ timeout: 30_000 });
      const runNumber = /(RUN-[\w-]+)/.exec(await planned.innerText())?.[1] ?? '';
      expect(runNumber).toMatch(/^RUN-/);

      // Put both deliveries on it. A delivery cannot be put on a run before one is chosen.
      await expect(ready.getByRole('button', { name: 'Choose a run first' }).first()).toBeDisabled();
      await pick(page, ready.getByRole('combobox', { name: 'Put deliveries on this run' }), runNumber, new RegExp(runNumber));
      await ready.getByRole('button', { name: `Put ${first} on the run` }).click();
      await expect(page.getByText(`${first} is on the run.`)).toBeVisible({ timeout: 30_000 });
      await ready.getByRole('button', { name: `Put ${second} on the run` }).click();
      await expect(page.getByText(`${second} is on the run.`)).toBeVisible({ timeout: 30_000 });
      await expect(ready.getByRole('button', { name: `Put ${first} on the run` })).toHaveCount(0);

      // The run: stops in order, moved, taken off and put back, then sent out together.
      const runLink = page.getByRole('region', { name: 'Runs to do' }).getByRole('link', { name: runNumber });
      await followLink(runLink, page, /\/admin\/delivery\/runs\//, page.getByRole('heading', { name: /^Run RUN-/, level: 2 }));
      await noHorizontalScroll(page);
      const stops = page.getByRole('region', { name: 'Stops' });
      await expect(stops).toContainText(first);
      await expect(stops).toContainText(second);
      await stops.getByRole('button', { name: `Move ${second} up` }).click();
      await expect(page.getByText('The stops are in the new order.')).toBeVisible({ timeout: 30_000 });
      await expect(stops.getByRole('listitem').first()).toContainText(second);
      await stops.getByRole('button', { name: 'Nearest first' }).click();
      await expect(page.getByText(/suggested order/)).toBeVisible({ timeout: 30_000 });
      await stops.getByRole('button', { name: `Take ${first} off the run` }).click();
      await expect(page.getByText(`${first} is off the run.`)).toBeVisible({ timeout: 30_000 });
      await expect(stops).not.toContainText(first);
      await page.getByRole('button', { name: 'Start the run' }).click();
      await expect(page.getByText(/^The run is on the road/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Start the run' })).toHaveCount(0);

      // Closing is refused while a delivery is still out; then it gets its result on its own screen, and the run closes.
      await page.getByRole('button', { name: 'Close the run' }).click();
      await expect(page.getByRole('alert').filter({ hasText: '1 delivery is still out' })).toBeVisible({ timeout: 30_000 });
      await stops.getByRole('link', { name: second }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`^Delivery ${second}`), level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^On run RUN-/).first()).toBeVisible();
      await page.getByLabel('Who received it').fill('Mama Wanjiku');
      await step(page, 'Mark delivered', 'Marked delivered.');
      await page.goBack();
      await page.reload();
      await expect(page.getByRole('heading', { name: /^Run RUN-/, level: 2 })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Close the run' }).click();
      await expect(page.getByText('The run is closed.')).toBeVisible({ timeout: 30_000 });

      // The first delivery came off the run, so it is ready and waiting on the board again.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      await expect(page.getByRole('region', { name: 'Ready to go' })).toContainText(first, { timeout: 30_000 });
      await open(page, '/admin/delivery/runs', 'Delivery runs');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await expect(page.getByRole('list', { name: 'Runs' })).toContainText('Completed');
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('a parcel handed to a courier is recorded with the courier, shown on the board, and its news is typed in', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      const orderNumber = deliveryTool('courier-order', tag).orderNumber ?? '';
      const made = deliveryTool('ready', orderNumber);
      const number = made.number ?? '';
      expect(number).toMatch(/^DLV-/);

      // Sent out with the courier's name and tracking number typed in.
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await page.getByLabel('Which courier has it').fill('Swift Couriers');
      await page.getByLabel(/tracking number/i).fill('SW123');
      await step(page, 'Send out', 'Sent out.');
      const courier = page.getByRole('region', { name: 'Courier' });
      await expect(courier).toContainText('Swift Couriers');
      await expect(courier).toContainText('tracking number SW123');

      // It is on the board with the courier; the courier's news is typed in.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      await noHorizontalScroll(page);
      const withCouriers = page.getByRole('region', { name: 'With couriers' });
      await expect(withCouriers).toContainText(number, { timeout: 30_000 });
      await withCouriers.getByText(`Record the courier’s news for ${number}`).click();
      await pick(page, withCouriers.getByRole('combobox', { name: `What the courier reported: ${number}` }), 'Still', /Still with the courier/);
      await withCouriers.getByLabel('Note').fill('At the Nairobi hub');
      await withCouriers.getByRole('button', { name: 'Record the news' }).click();
      await expect(page.getByText(`The news for ${number} is recorded.`)).toBeVisible({ timeout: 30_000 });
      await expect(withCouriers).toContainText('At the Nairobi hub');

      await pick(page, withCouriers.getByRole('combobox', { name: `What the courier reported: ${number}` }), 'Delivered', /^Delivered/);
      await withCouriers.getByLabel('Who received it').fill('Gate guard');
      await withCouriers.getByRole('button', { name: 'Record the news' }).click();
      await expect(page.getByText(`The news for ${number} is recorded.`)).toBeVisible({ timeout: 30_000 });
      await expect(withCouriers).not.toContainText(number);

      // The delivery itself is delivered, with the courier's word for it on its history.
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await expect(page.getByText('Received by Gate guard')).toBeVisible();
      await expect(page.getByRole('region', { name: 'History' })).toContainText('Mark delivered');
    } finally {
      deliveryTool('close', tag);
    }
  });
});
