import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makePlace, setLedger, stockedProduct } from './support/stock-fixtures';
import { vanTool } from './support/van-fixtures';

test.beforeAll(() => {
  setLedger('on');
  vanTool('moment', 'delivery');
  vanTool('reset-rep', 'start');
});
test.afterAll(() => {
  vanTool('moment', 'payment');
  vanTool('reset-rep', 'end');
  setLedger('off');
});

async function chooseFirst(page: Page, field: Locator, text = ''): Promise<void> {
  await expect(async () => {
    await field.click();
    if (text !== '') await field.fill(text);
    await page.getByRole('option').first().click({ timeout: 4000 });
  }).toPass({ timeout: 120_000 });
}

async function open(trigger: Locator, target: Locator): Promise<void> {
  await expect(async () => {
    await trigger.click();
    await expect(target).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000 });
}

/** A Monday some weeks ahead, so each project plans its day on a date of its own (the rep has one day a date). */
function mondayAhead(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

test.describe('van sales: delivering a pre-sold order from the van', () => {
  test('the planner adds an order, the load carries it, the rep delivers it at the customer and the visit is finished as delivered', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const tag = `dp${String(Date.now()).slice(-6)}${phone ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag, 'admin');
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    const place = `VDW${tag}`.toUpperCase();
    makePlace(place, `Drop warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    const order = vanTool('order', shops[0] ?? '', soda.id, '3').orderNumber ?? '';

    // Plan the day (the route's usual rep is this account) and load the van.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    const plan = page.getByRole('form', { name: 'Plan a day' });
    await open(page.getByRole('button', { name: 'Plan a day' }), plan);
    await chooseFirst(page, plan.getByRole('combobox', { name: /Route/ }), routeName);
    await plan.getByLabel('Date').fill(mondayAhead(phone ? 5 : 4));
    await plan.getByRole('button', { name: 'Plan the day' }).click();
    await expect(page).toHaveURL(/\/admin\/van-sales\/days\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 30_000 });
    const day = page.getByRole('region', { name: 'The day', exact: true });
    const send = page.getByRole('region', { name: 'Send the day out' });
    await expect(send).toContainText('Not ready');
    await expect(send).toContainText('The van has no stock yet');
    await expect(send.getByRole('button', { name: 'Send the day out' })).toBeDisabled();

    // The planner adds the customer's order to the day's deliveries, and the load planner counts it.
    const drops = page.getByRole('region', { name: 'Deliveries', exact: true });
    await open(drops.getByRole('button', { name: 'Add an order' }), page.getByRole('form', { name: 'Add an order to deliver' }));
    const add = page.getByRole('form', { name: 'Add an order to deliver' });
    await chooseFirst(page, add.getByRole('combobox', { name: /Order/ }), order);
    await add.getByRole('button', { name: 'Add to the deliveries' }).click();
    const rows = drops.getByRole('list', { name: 'Orders to deliver' }).locator(':scope > li');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.first()).toContainText(order);
    await expect(rows.first()).toContainText('At the warehouse, not loaded yet');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const planner = page.getByRole('region', { name: 'Make up the load' });
    await expect(planner).toBeVisible({ timeout: 60_000 });
    await chooseFirst(page, planner.getByRole('combobox', { name: /Load from/ }), `Drop warehouse ${tag}`);
    await expect(planner.getByLabel(`Load of ${soda.name}`)).toHaveValue('3', { timeout: 30_000 });
    await planner.getByRole('button', { name: 'Ask for the load' }).click();
    const cards = page.getByRole('list', { name: 'Loads of the day' }).locator(':scope > li');
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    await expect(async () => {
      if (await cards.first().getByRole('button', { name: 'Send it' }).isVisible()) await cards.first().getByRole('button', { name: 'Send it' }).click();
      await expect(cards.first()).toContainText('On its way to the van', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    // This account is the rep, so it signs without a reason.
    await open(cards.first().getByRole('button', { name: 'Sign for the load' }), page.getByRole('form', { name: /^Sign for / }));
    const sign = page.getByRole('form', { name: /^Sign for / });
    await expect(sign.getByLabel('Why are you signing for the rep?')).toHaveCount(0);
    await sign.getByRole('button', { name: 'Sign for it' }).click();
    await expect(cards.first()).toContainText('Signed for', { timeout: 30_000 });
    await expect(cards.first().getByTestId('load-signed')).not.toContainText("on the rep's behalf");

    // Send the day out with the float counted into the till.
    await expect(send).toContainText('Ready to go', { timeout: 30_000 });
    await send.getByLabel(/Cash counted into the van/).fill('1500');
    await send.getByRole('button', { name: 'Send the day out' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The day is out on the route' })).toBeVisible({ timeout: 30_000 });
    await expect(day).toContainText('Out on the route');
    await expect(page.getByRole('region', { name: 'Send the day out' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel this day' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The day went out on the route');

    // Loaded: the stock of the delivery is held on the van, and the planner can no longer take it off.
    await expect(rows.first()).toContainText('On the van', { timeout: 30_000 });
    await expect(rows.first().getByRole('button', { name: `Take ${order} off the deliveries` })).toHaveCount(0);
    // At the customer: arrive, then deliver to a named person.
    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    await expect(rows.first()).toContainText(`Arrive at ${shops[0] ?? ''} to deliver this`);
    await expect(async () => {
      await page.getByRole('button', { name: `Arrive at ${shops[0] ?? ''}` }).click();
      await expect(visits.nth(0)).toContainText('At the customer', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''}`, exact: true })).toHaveCount(0);
    await open(rows.first().getByRole('button', { name: `Deliver ${order}` }), page.getByRole('form', { name: `Deliver ${order}` }));
    const deliver = page.getByRole('form', { name: `Deliver ${order}` });
    await expect(deliver.getByRole('button', { name: 'Delivered' })).toBeDisabled();
    await deliver.getByLabel('Who received the goods').fill('Mama Njeri');
    await deliver.getByRole('button', { name: 'Delivered' }).click();
    await expect(rows.first()).toContainText('Delivered', { timeout: 60_000 });
    await expect(rows.first().getByRole('button', { name: `Deliver ${order}` })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'is delivered to' })).toBeVisible();
    // The visit is finished as delivered, never as no sale.
    await expect(page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''} with no sale` })).toHaveCount(0);
    await page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''}`, exact: true }).click();
    await expect(visits.nth(0)).toContainText('Done', { timeout: 30_000 });
    await expect(visits.nth(0).getByTestId('visit-facts')).toContainText('Delivered');
    await expect(page.getByRole('list', { name: 'History' })).toContainText('An order was delivered');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
