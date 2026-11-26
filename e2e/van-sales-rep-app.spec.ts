import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { makePlace, quantityAt, setLedger, stockedProduct } from './support/stock-fixtures';
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

/** The first Monday after today, or a week later: both are inside the fortnight the rep's phone shows, and each project takes one (the rep has one day a date). */
function mondayAhead(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

test.describe('van sales: the rep app on a phone', () => {
  test('the rep sees the day on the home screen, opens it, reaches the next customer, arrives, takes an order and moves on', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const tag = `rp${String(Date.now()).slice(-6)}${phone ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag, 'admin');
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    const place = `VPW${tag}`.toUpperCase();
    makePlace(place, `Phone warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    vanTool('par', routeName, soda.id, '20');
    const dayFix = vanTool('out-day', routeName, place, mondayAhead(phone ? 1 : 0));

    // The home screen: the day, how far along it is, and who is next.
    await page.goto('/rep');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    const card = page.getByRole('link', { name: new RegExp(routeName) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Out on the route');
    await expect(card).toContainText('0 of 3 visits');
    await expect(card).toContainText(`Next: ${shops[0] ?? ''}`);
    await noHorizontalScroll(page);
    await expect(async () => {
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/rep/days/${dayFix.dayId ?? ''}$`), { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: dayFix.number ?? '', level: 1 })).toBeVisible({ timeout: 30_000 });

    // The next stop: who, where, ways to reach them, and one large button.
    const next = page.getByRole('region', { name: 'Next stop', exact: true });
    await expect(next).toContainText(shops[0] ?? '');
    await expect(next.getByRole('link', { name: `Call ${shops[0] ?? ''}` })).toHaveAttribute('href', /^tel:\+2547\d{8}$/);
    await expect(next.getByRole('link', { name: `WhatsApp ${shops[0] ?? ''}` })).toHaveAttribute('href', /^https:\/\/wa\.me\/2547\d{8}$/);
    await expect(next.getByRole('link', { name: `Directions to ${shops[0] ?? ''}` })).toHaveAttribute('href', /maps\/dir\/\?api=1&destination=Ruiru$/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    const here = next.getByRole('button', { name: `I am at ${shops[0] ?? ''}` });
    await expect(here).toBeVisible();
    const box = await here.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    await expect(async () => {
      if (await here.isVisible()) await here.click();
      await expect(visits.nth(0)).toContainText('At the customer', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(next).toContainText('You are at');

    // Orders are taken at a customer the rep is at, and are priced by the system.
    await open(page.getByRole('button', { name: `Take an order from ${shops[0] ?? ''}` }), page.getByRole('form', { name: `Take an order from ${shops[0] ?? ''}` }));
    const order = page.getByRole('form', { name: `Take an order from ${shops[0] ?? ''}` });
    await expect(order.getByRole('button', { name: 'Take the order' })).toBeDisabled();
    await expect(order.getByLabel(/Price of/)).toHaveCount(0);
    await expect(order.getByRole('group', { name: 'Payment' })).toHaveCount(0);
    await chooseFirst(page, order.getByRole('combobox', { name: /Add a product/ }), soda.name);
    await order.getByLabel(`Quantity of ${soda.name}`).fill('3');
    await expect(order.getByTestId('sale-total')).toContainText('Total KES', { timeout: 30_000 });
    await order.getByLabel('Day the customer needs the order').fill(mondayAhead(phone ? 7 : 6));
    await noNativeSelect(page);
    await order.getByRole('button', { name: 'Take the order' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'taken for KES' })).toBeVisible({ timeout: 60_000 });
    const sales = page.getByRole('region', { name: 'Sales', exact: true });
    const made = sales.getByRole('list', { name: 'Sales made' }).getByRole('listitem');
    await expect(made).toHaveCount(1);
    await expect(made.first()).toContainText('Order');
    await expect(sales).toContainText('Orders for later');
    // Nothing was paid and nothing left the van or the warehouse's shelves.
    await expect(sales.getByTestId('day-sales-total')).toContainText('KES 0.00');
    expect(quantityAt(soda.name, place)).toBe(20);
    await expect(page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''} with no sale` })).toHaveCount(0);
    await page.getByRole('button', { name: `Finish the visit to ${shops[0] ?? ''}`, exact: true }).click();
    await expect(visits.nth(0)).toContainText('Done', { timeout: 30_000 });
    await expect(visits.nth(0).getByTestId('visit-facts')).toContainText('Order taken');
    // With the first customer done, the next stop is the second.
    await expect(next).toContainText(shops[1] ?? '', { timeout: 30_000 });
    await expect(next).toContainText('Next stop');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await page.getByRole('link', { name: 'My days' }).click();
    await expect(page.getByRole('link', { name: new RegExp(routeName) })).toContainText('1 of 3 visits', { timeout: 30_000 });
  });
});
