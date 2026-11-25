import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makePlace, quantityAt, setLedger, stockedProduct } from './support/stock-fixtures';
import { vanTool } from './support/van-fixtures';

test.beforeAll(() => setLedger('on'));
test.afterAll(() => setLedger('off'));

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

/** A Monday at least a week ahead, so a day can be planned on it whatever today is. */
function mondayAhead(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test.describe('van sales: loading a van', () => {
  test('a load is made up from the route\'s usual stock, called off and made again, sent, signed for by the office on the rep\'s behalf, and keeps the day from being cancelled while its stock is on the van', async ({ page }, testInfo) => {
    test.slow();
    const tag = `ld${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag);
    const routeName = fixture.route ?? '';
    const place = `VLW${tag}`.toUpperCase();
    makePlace(place, `Load warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    vanTool('par', routeName, soda.id, '20');

    // Plan the day.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    const plan = page.getByRole('form', { name: 'Plan a day' });
    await open(page.getByRole('button', { name: 'Plan a day' }), plan);
    await chooseFirst(page, plan.getByRole('combobox', { name: /Route/ }), routeName);
    await plan.getByLabel('Date').fill(mondayAhead());
    await plan.getByRole('button', { name: 'Plan the day' }).click();
    await expect(page).toHaveURL(/\/admin\/van-sales\/days\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 30_000 });
    const day = page.getByRole('region', { name: 'The day', exact: true });
    await expect(page.getByRole('region', { name: 'On the van now' })).toContainText('Nothing is on the van yet');

    // The planner: choose the warehouse, see the usual stock suggested, change the quantity, ask for it.
    const planner = page.getByRole('region', { name: 'Make up the load' });
    await expect(planner).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await chooseFirst(page, planner.getByRole('combobox', { name: /Load from/ }), `Load warehouse ${tag}`);
    await expect(planner.getByRole('list', { name: 'To load' })).toContainText(soda.name, { timeout: 30_000 });
    await expect(planner.getByRole('list', { name: 'To load' })).toContainText('Usual 20 · on the van 0 · warehouse has 40');
    await expect(planner.getByLabel(`Load of ${soda.name}`)).toHaveValue('20');
    await planner.getByLabel(`Load of ${soda.name}`).fill('15');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await planner.getByRole('button', { name: 'Ask for the load' }).click();
    const loads = page.getByRole('list', { name: 'Loads of the day' });
    // A load card holds its own list of lines, so the loads are the direct children only.
    const cards = loads.locator(':scope > li');
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    await expect(loads).toContainText('Asked for');
    await expect(loads).toContainText(`${soda.name} asked 15`);
    await expect(day).toContainText('Being loaded');
    await expect(page.getByRole('list', { name: 'History' })).toContainText('Loading began');
    await expect(page.getByRole('list', { name: 'History' })).toContainText('A load was made up');
    await expect(page.getByRole('region', { name: 'Make up the load' })).toHaveCount(0);

    // Called off (a reason is needed): the planner comes back.
    await open(loads.getByRole('button', { name: 'Call it off' }), page.getByRole('form', { name: /^Call off / }));
    const off = page.getByRole('form', { name: /^Call off / });
    await expect(off.getByRole('button', { name: 'Call the load off' })).toBeDisabled();
    await off.getByLabel('Why?').fill('The van is being washed first');
    await off.getByRole('button', { name: 'Call the load off' }).click();
    await expect(loads).toContainText('Called off because: The van is being washed first', { timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Make up the load' })).toBeVisible({ timeout: 30_000 });

    // Made up again, this time sent.
    const again = page.getByRole('region', { name: 'Make up the load' });
    await chooseFirst(page, again.getByRole('combobox', { name: /Load from/ }), `Load warehouse ${tag}`);
    await expect(again.getByLabel(`Load of ${soda.name}`)).toBeVisible({ timeout: 30_000 });
    await again.getByLabel(`Load of ${soda.name}`).fill('15');
    await again.getByRole('button', { name: 'Ask for the load' }).click();
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const live = cards.nth(1);
    await expect(live).toContainText('Asked for');
    expect(quantityAt(soda.name, place)).toBe(40); // nothing has left the warehouse yet
    await expect(async () => {
      if (await live.getByRole('button', { name: 'Send it' }).isVisible()) await live.getByRole('button', { name: 'Send it' }).click();
      await expect(live).toContainText('On its way to the van', { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    expect(quantityAt(soda.name, place)).toBe(25);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The load left the warehouse');

    // The day cannot be cancelled while the load is on its way.
    await page.getByRole('button', { name: 'Cancel this day' }).click();
    const why = page.getByRole('form', { name: /^Cancel VDY-/ });
    await why.getByLabel('Why?').fill('The customers are closed that day');
    await why.getByRole('button', { name: 'Cancel the day' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'is on its way to the van' })).toBeVisible({ timeout: 30_000 });
    await why.getByRole('button', { name: 'Keep it as it is' }).click();

    // Signed for: the office signs for the rep, which needs a reason.
    await open(live.getByRole('button', { name: 'Sign for the load' }), page.getByRole('form', { name: /^Sign for / }));
    const sign = page.getByRole('form', { name: /^Sign for / });
    // The office signing for the rep must say why; then the count is checked against what was sent.
    await sign.getByRole('button', { name: 'Sign for it' }).click();
    await expect(sign.getByRole('alert')).toContainText('needs a reason', { timeout: 30_000 });
    await sign.getByLabel('Why are you signing for the rep?').fill('The rep signed the paper copy at the depot');
    await sign.getByLabel(`Counted ${soda.name}`).fill('20');
    await sign.getByRole('button', { name: 'Sign for it' }).click();
    await expect(sign.getByRole('alert')).toContainText('Only 15 of', { timeout: 30_000 });
    await sign.getByLabel(`Counted ${soda.name}`).fill('15');
    await sign.getByRole('button', { name: 'Sign for it' }).click();
    await expect(live).toContainText('Signed for', { timeout: 30_000 });
    await expect(live.getByTestId('load-signed')).toContainText("on the rep's behalf: The rep signed the paper copy at the depot");
    const onVan = page.getByRole('region', { name: 'On the van now' });
    await expect(onVan).toContainText(soda.name);
    await expect(onVan).toContainText('15');
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The load was signed for');
    await expect(page.getByRole('region', { name: 'Make up the load' })).toHaveCount(0);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Now the stock is on the van, so the day still cannot be cancelled.
    await page.getByRole('button', { name: 'Cancel this day' }).click();
    const why2 = page.getByRole('form', { name: /^Cancel VDY-/ });
    await why2.getByLabel('Why?').fill('The customers are closed that day');
    await why2.getByRole('button', { name: 'Cancel the day' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'still on the van' })).toBeVisible({ timeout: 30_000 });
  });
});
