import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makePlace, setLedger, stockedProduct } from './support/stock-fixtures';
import { vanTool } from './support/van-fixtures';

test.beforeAll(() => {
  setLedger('on');
  vanTool('reset-rep', 'start');
});
test.afterAll(() => {
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

test.describe('van sales: running the day as the rep', () => {
  test('the rep signs for the load, sends the day out with a float, and works the visits: arrive, finish with no sale, skip, a shop found shut, a customer added on the road', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const tag = `rn${String(Date.now()).slice(-6)}${phone ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag, 'admin');
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    const place = `VRW${tag}`.toUpperCase();
    makePlace(place, `Run warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    vanTool('par', routeName, soda.id, '20');
    const extra = vanTool('customer', `${tag}x`, '1').names ?? '';

    // Plan the day (the route's usual rep is this account) and load the van.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    const plan = page.getByRole('form', { name: 'Plan a day' });
    await open(page.getByRole('button', { name: 'Plan a day' }), plan);
    await chooseFirst(page, plan.getByRole('combobox', { name: /Route/ }), routeName);
    await plan.getByLabel('Date').fill(mondayAhead(phone ? 3 : 2));
    await plan.getByRole('button', { name: 'Plan the day' }).click();
    await expect(page).toHaveURL(/\/admin\/van-sales\/days\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 30_000 });
    const day = page.getByRole('region', { name: 'The day', exact: true });
    const send = page.getByRole('region', { name: 'Send the day out' });
    await expect(send).toContainText('Not ready');
    await expect(send).toContainText('The van has no stock yet');
    await expect(send.getByRole('button', { name: 'Send the day out' })).toBeDisabled();

    const planner = page.getByRole('region', { name: 'Make up the load' });
    await expect(planner).toBeVisible({ timeout: 60_000 });
    await chooseFirst(page, planner.getByRole('combobox', { name: /Load from/ }), `Run warehouse ${tag}`);
    await expect(planner.getByLabel(`Load of ${soda.name}`)).toHaveValue('20', { timeout: 30_000 });
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
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await send.getByLabel(/Cash counted into the van/).fill('lots');
    await send.getByRole('button', { name: 'Send the day out' }).click();
    await expect(send.getByRole('alert')).toContainText('cash counted into the van', { timeout: 30_000 });
    await send.getByLabel(/Cash counted into the van/).fill('1500');
    await send.getByRole('button', { name: 'Send the day out' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The day is out on the route' })).toBeVisible({ timeout: 30_000 });
    await expect(day).toContainText('Out on the route');
    await expect(page.getByRole('region', { name: 'Send the day out' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel this day' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The day went out on the route');

    // The visits. The first: arrive, then finish with no sale (a reason is needed).
    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    await expect(visits).toHaveCount(3);
    await expect(page.getByRole('button', { name: `Move ${shops[0] ?? ''} up` })).toHaveCount(0); // the planner can no longer arrange them
    await expect(async () => {
      await page.getByRole('button', { name: `Arrive at ${shops[0] ?? ''}` }).click();
      await expect(visits.nth(0)).toContainText('At the customer', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(visits.nth(0).getByTestId('visit-facts')).toContainText('Arrived');
    // One at a time: a second visit cannot be started while one is under way.
    await page.getByRole('button', { name: `Arrive at ${shops[1] ?? ''}` }).click();
    await expect(page.getByRole('alert').filter({ hasText: `Finish the visit at ${shops[0] ?? ''}` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''} with no sale` }).click();
    const finish = page.getByRole('form', { name: `Finish ${shops[0] ?? ''}` });
    await expect(finish.getByRole('button', { name: 'Finish the visit' })).toBeDisabled();
    await finish.getByLabel('Why?').fill('Has enough stock for the week');
    await finish.getByRole('button', { name: 'Finish the visit' }).click();
    await expect(visits.nth(0)).toContainText('Done', { timeout: 30_000 });
    await expect(visits.nth(0).getByTestId('visit-facts')).toContainText('No sale: Has enough stock for the week');

    // The second is skipped with a reason; the third is found shut.
    await page.getByRole('button', { name: `Skip ${shops[1] ?? ''}` }).click();
    const skip = page.getByRole('form', { name: `Skip ${shops[1] ?? ''}` });
    await skip.getByLabel('Why?').fill('The road to the shop is flooded');
    await skip.getByRole('button', { name: 'Skip this customer' }).click();
    await expect(visits.nth(1)).toContainText('Skipped', { timeout: 30_000 });
    await expect(visits.nth(1).getByTestId('visit-facts')).toContainText('Because: The road to the shop is flooded');
    const shut = page.getByRole('button', { name: `Confirm: ${shops[2] ?? ''}'s shop is closed` });
    await open(page.getByRole('button', { name: `${shops[2] ?? ''}'s shop is closed` }), shut);
    await expect(async () => {
      if (await shut.isVisible()) await shut.click();
      await expect(visits.nth(2)).toContainText('Shop closed', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });

    // A customer added on the road, then found shut too.
    const add = page.getByRole('form', { name: 'Add a customer to the day' });
    await open(page.getByRole('button', { name: 'Add a customer' }), add);
    await chooseFirst(page, add.getByRole('combobox', { name: /Customer/ }), extra);
    await add.getByRole('button', { name: 'Add to the visits' }).click();
    await expect(visits).toHaveCount(4, { timeout: 30_000 });
    await expect(visits.nth(3)).toContainText(extra);
    await expect(visits.nth(3)).toContainText('Added to this day by hand');
    const history = page.getByRole('list', { name: 'History' });
    for (const words of ['The rep arrived at a customer', 'A visit was finished', 'A visit was skipped', 'The shop was found closed', 'The rep added a customer on the road']) await expect(history).toContainText(words);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
