import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder } from './support/delivery-shop';
import { riderTool } from './support/rider-fixtures';

const today = (): string => new Date().toISOString().slice(0, 10);

test.describe('delivery vehicles', () => {
  test('a vehicle is added with a limit, a duplicate is refused, a run in it cannot take more stops than it allows, and the vehicle can be stopped', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const bike = `Bike ${tag}`;
    deliveryTool('open', tag);
    try {
      const first = deliveryTool('ready', await placeDeliveredOrder(page)).number ?? '';
      const second = deliveryTool('ready', await placeDeliveredOrder(page)).number ?? '';

      await open(page, '/admin/delivery/vehicles', 'Vehicles');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      const form = page.getByRole('form', { name: 'Add a vehicle' });
      await form.getByLabel('Name or number plate').fill(bike);
      await form.getByLabel('Most weight it carries (kg)').fill('heavy');
      await form.getByRole('button', { name: 'Add the vehicle' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'The weight limit is more than nothing' })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('Most weight it carries (kg)').fill('25');
      await form.getByLabel('Most stops on a run').fill('1');
      await form.getByRole('button', { name: 'Add the vehicle' }).click();
      await expect(page.getByText('The vehicle is added.')).toBeVisible({ timeout: 30_000 });
      const row = page.getByRole('list', { name: 'Vehicle list' }).getByRole('listitem').filter({ hasText: bike });
      await expect(row).toContainText('up to 25 kg · 1 stop a run');
      await expect(row).toContainText('In use');

      // The same name in another case is the same vehicle.
      await form.getByLabel('Name or number plate').fill(bike.toUpperCase());
      await form.getByRole('button', { name: 'Add the vehicle' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'already in the list' })).toBeVisible({ timeout: 30_000 });
      await noInnerHorizontalScroll(page);

      // Plan a run in it from the dispatch board and put both deliveries on it: the second is over the vehicle's limit.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      const plan = page.getByRole('region', { name: 'Plan a run' });
      await pick(page, plan.getByRole('combobox', { name: 'Leaves from' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await plan.getByLabel('Day').fill(today());
      await plan.getByLabel('Or a name, for someone not using the app').fill('Otieno');
      await pick(page, plan.getByRole('combobox', { name: 'Vehicle (optional)' }), bike, new RegExp(bike));
      await expect(plan.getByLabel('Or a vehicle typed in')).toBeDisabled();
      await plan.getByRole('button', { name: 'Plan the run' }).click();
      const planned = page.getByText(/^Run RUN-.* is planned/);
      await expect(planned).toBeVisible({ timeout: 30_000 });
      const runNumber = /(RUN-[\w-]+)/.exec(await planned.innerText())?.[1] ?? '';
      const ready = page.getByRole('region', { name: 'Ready to go' });
      await expect(ready).toContainText(first, { timeout: 30_000 });
      await pick(page, ready.getByRole('combobox', { name: 'Put deliveries on this run' }), runNumber, new RegExp(runNumber));
      await ready.getByRole('button', { name: `Put ${first} on the run` }).click();
      await expect(page.getByText(`${first} is on the run.`)).toBeVisible({ timeout: 30_000 });
      await ready.getByRole('button', { name: `Put ${second} on the run` }).click();
      await expect(page.getByRole('alert').filter({ hasText: `${bike} takes at most 1 stop on a run; this would be 2.` })).toBeVisible({ timeout: 30_000 });
      await expect(ready.getByRole('button', { name: `Put ${second} on the run` })).toBeVisible();

      // The run says what it carries against the limit.
      await page.getByRole('region', { name: 'Runs to do' }).getByRole('link', { name: runNumber }).click();
      await expect(page.getByRole('heading', { name: /^Run RUN-/, level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('region', { name: 'Vehicle' })).toContainText(`${bike} takes`);
      await expect(page.getByRole('region', { name: 'Vehicle' })).toContainText('1 of 1 stop');
      await noHorizontalScroll(page);

      // A vehicle that is no longer used is stopped, not removed.
      await open(page, '/admin/delivery/vehicles', 'Vehicles');
      const again = page.getByRole('list', { name: 'Vehicle list' }).getByRole('listitem').filter({ hasText: bike });
      await expect(again).toContainText('1 run planned or out now');
      await again.getByRole('button', { name: 'Stop using' }).click();
      await expect(page.getByText(`${bike} is stopped.`)).toBeVisible({ timeout: 30_000 });
      await expect(again).toContainText('Stopped');
    } finally {
      deliveryTool('close', tag);
    }
  });
  test('a rider\'s usual vehicle is chosen from the list, shown on their card, and is the vehicle of a run planned for them', async ({ page }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const vehicle = `Usual ${tag}`;
    const name = `Wafula ${tag}`;
    deliveryTool('open', tag);
    try {
      await open(page, '/admin/delivery/vehicles', 'Vehicles');
      const add = page.getByRole('form', { name: 'Add a vehicle' });
      await add.getByLabel('Name or number plate').fill(vehicle);
      await add.getByRole('button', { name: 'Add the vehicle' }).click();
      await expect(page.getByText('The vehicle is added.')).toBeVisible({ timeout: 30_000 });

      // A rider is made with that vehicle as their usual one.
      await open(page, '/admin/delivery/riders', 'Riders');
      await noNativeSelect(page);
      const kinds = page.getByRole('region', { name: 'Who rides' });
      if ((await page.getByRole('form', { name: 'Make an account for a rider' }).count()) === 0) {
        await kinds.getByLabel(/Own rider account/).check();
        await kinds.getByRole('button', { name: 'Save' }).click();
        await expect(page.getByText(/Saved\. This is who can be a rider/)).toBeVisible({ timeout: 30_000 });
      }
      const form = page.getByRole('form', { name: 'Make an account for a rider' });
      await form.getByLabel('Name').fill(name);
      await form.getByLabel('Email to sign in with').fill(`e2e-usual-${tag}@example.test`.toLowerCase());
      await form.getByLabel('Phone').fill('0722 555 666');
      await form.getByLabel('First password').fill('E2eUsualFirst-Pass1');
      await pick(page, form.getByRole('combobox', { name: 'Usual vehicle (optional)' }), vehicle, new RegExp(vehicle));
      await expect(form.getByLabel('Or a vehicle typed in')).toBeDisabled();
      await form.getByRole('button', { name: 'Create the account' }).click();
      await expect(page.getByText(new RegExp(`${name} has an account`))).toBeVisible({ timeout: 30_000 });
      const card = page.getByRole('list', { name: 'List of riders' }).getByRole('listitem').filter({ hasText: name });
      await expect(card).toContainText(vehicle);
      await expect(card.getByRole('combobox', { name: `Usual vehicle of ${name}` })).toBeVisible();
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // A run planned for that rider, with no vehicle chosen, goes in it.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      const plan = page.getByRole('region', { name: 'Plan a run' });
      await pick(page, plan.getByRole('combobox', { name: 'Leaves from' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await plan.getByLabel('Day').fill(new Date().toISOString().slice(0, 10));
      await pick(page, plan.getByRole('combobox', { name: 'Rider' }), name, new RegExp(name));
      await plan.getByRole('button', { name: 'Plan the run' }).click();
      await expect(page.getByText(new RegExp(`^Run RUN-.* is planned in ${vehicle}\\.`))).toBeVisible({ timeout: 30_000 });
    } finally {
      // This test switched own-account riders on; other specs expect the default (staff only), so it is put back.
      riderTool('reset', tag);
      deliveryTool('close', tag);
    }
  });
});
