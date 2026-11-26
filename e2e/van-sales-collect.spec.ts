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

test.describe('van sales: collecting money', () => {
  test('the rep collects part of what a customer owes in cash, and the cash goes into the till of the van', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const tag = `cl${String(Date.now()).slice(-6)}${phone ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag, 'admin');
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    const place = `VKW${tag}`.toUpperCase();
    const invoice = vanTool('owe', shops[0] ?? '', '2000').documentNo ?? '';
    makePlace(place, `Sell warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    vanTool('par', routeName, soda.id, '20');
    // Plan the day (the route's usual rep is this account) and load the van.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    const plan = page.getByRole('form', { name: 'Plan a day' });
    await open(page.getByRole('button', { name: 'Plan a day' }), plan);
    await chooseFirst(page, plan.getByRole('combobox', { name: /Route/ }), routeName);
    await plan.getByLabel('Date').fill(mondayAhead(phone ? 15 : 14));
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
    await chooseFirst(page, planner.getByRole('combobox', { name: /Load from/ }), `Sell warehouse ${tag}`);
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
    await send.getByLabel(/Cash counted into the van/).fill('1500');
    await send.getByRole('button', { name: 'Send the day out' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The day is out on the route' })).toBeVisible({ timeout: 30_000 });
    await expect(day).toContainText('Out on the route');
    await expect(page.getByRole('region', { name: 'Send the day out' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel this day' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The day went out on the route');

    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    await expect(day).toContainText('Out on the route');
    // Selling needs a visit under way.
    await expect(page.getByRole('button', { name: `Sell to ${shops[0] ?? ''}` })).toHaveCount(0);
    await expect(async () => {
      await page.getByRole('button', { name: `Arrive at ${shops[0] ?? ''}` }).click();
      await expect(visits.nth(0)).toContainText('At the customer', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    // The customer owes an invoice: the rep sees it, collects part of it in cash, and the cash goes into the van's till.
    const cash = page.getByRole('region', { name: 'Cash on the van', exact: true });
    await expect(cash.getByTestId('van-cash')).toContainText('1,500.00', { timeout: 30_000 });
    await open(page.getByRole('button', { name: `Collect from ${shops[0] ?? ''}` }), page.getByRole('form', { name: `Collect from ${shops[0] ?? ''}` }));
    const form = page.getByRole('form', { name: `Collect from ${shops[0] ?? ''}` });
    await expect(form.getByTestId('owing-total')).toContainText('owes KES 2,000.00');
    await expect(form.getByRole('list', { name: 'What is owed' })).toContainText(invoice);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await form.getByLabel('Amount collected').fill('5000');
    await form.getByRole('button', { name: 'Collect', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('cannot collect more', { timeout: 30_000 });
    await form.getByLabel('Amount collected').fill('800');
    await form.getByRole('button', { name: 'Collect', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'was collected from' })).toBeVisible({ timeout: 60_000 });
    await expect(cash.getByTestId('van-cash')).toContainText('2,300.00');
    const sales = page.getByRole('region', { name: 'Sales', exact: true });
    const collected = sales.getByRole('list', { name: 'Money collected' }).getByRole('listitem');
    await expect(collected).toHaveCount(1);
    await expect(collected.first()).toContainText(shops[0] ?? '');
    await expect(collected.first()).toContainText('800.00');
    await expect(page.getByRole('list', { name: 'History' })).toContainText('Money was collected from a customer');
    // A visit with only money collected is finished as collected, never as no sale.
    await expect(page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''} with no sale` })).toHaveCount(0);
    await page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''}`, exact: true }).click();
    await expect(visits.nth(0)).toContainText('Done', { timeout: 30_000 });
    await expect(visits.nth(0).getByTestId('visit-facts')).toContainText('Collected');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
