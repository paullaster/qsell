import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { vanTool } from './support/van-fixtures';

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
function mondayAhead(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

/** Plans a day on the Van days screen and answers the form, so a test can look at what came of it. */
async function planDay(page: Page, routeName: string, date: string): Promise<Locator> {
  const form = page.getByRole('form', { name: 'Plan a day' });
  await open(page.getByRole('button', { name: 'Plan a day' }), form);
  await chooseFirst(page, form.getByRole('combobox', { name: /Route/ }), routeName);
  await form.getByLabel('Date').fill(date);
  await form.getByRole('button', { name: 'Plan the day' }).click();
  return form;
}

test.describe('van sales: days', () => {
  test('a day is planned from a route and a date with the customers due, refused a second time, arranged, cancelled with a reason, and keeps its route from being stopped while open', async ({ page }, testInfo) => {
    test.slow();
    const tag = `dy${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag);
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    expect(shops).toHaveLength(3);
    const extra = vanTool('customer', `${tag}x`, '1').names ?? '';
    const date = mondayAhead(0);

    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // Plan it: the three customers are due, in the order of the round.
    await planDay(page, routeName, date);
    await expect(page).toHaveURL(/\/admin\/van-sales\/days\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 30_000 });
    const day = page.getByRole('region', { name: 'The day', exact: true });
    await expect(day).toContainText('Planned');
    await expect(day).toContainText(`Rep ${fixture.rep ?? ''}`);
    await expect(day).toContainText(`van ${fixture.van ?? ''}`);
    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    await expect(visits).toHaveCount(3);
    for (const [i, shop] of shops.entries()) await expect(visits.nth(i)).toContainText(shop);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The day was planned');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The same route on the same date is refused in words.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    const again = await planDay(page, routeName, date);
    await expect(again.getByRole('alert')).toContainText('This route already has a day on that date', { timeout: 30_000 });
    await again.getByRole('button', { name: 'Cancel' }).click();

    // Back to the day: add a customer by hand, move it up, take it off.
    await search(page, 'Search days', routeName);
    await page.getByRole('link', { name: /^Open day VDY-/ }).first().click();
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 60_000 });
    const add = page.getByRole('form', { name: 'Add a customer to the day' });
    await open(page.getByRole('button', { name: 'Add a customer' }), add);
    await chooseFirst(page, add.getByRole('combobox', { name: /Customer/ }), extra);
    await add.getByRole('button', { name: 'Add to the visits' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${extra} is on the day's visits` })).toBeVisible({ timeout: 30_000 });
    await expect(visits).toHaveCount(4);
    await expect(visits.nth(3)).toContainText('Added to this day by hand');
    await page.getByRole('button', { name: `Move ${extra} up` }).click();
    await expect(page.getByRole('status').filter({ hasText: `${extra} moved up` })).toBeVisible({ timeout: 30_000 });
    await expect(visits.nth(2)).toContainText(extra);
    const confirm = page.getByRole('button', { name: `Confirm: Take ${extra} off the day` });
    await open(page.getByRole('button', { name: `Take ${extra} off the day` }), confirm);
    await expect(async () => {
      if (await confirm.isVisible()) await confirm.click();
      await expect(page.getByRole('status').filter({ hasText: `${extra} is off the day's visits` })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(visits).toHaveCount(3);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The visits were put in a new order');

    // While the day is open its route cannot be stopped.
    await expect(async () => {
      await page.getByRole('link', { name: 'Open the route' }).click();
      await expect(page.getByRole('heading', { name: routeName, level: 2 })).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Stop this route' }).click();
    const stop = page.getByRole('form', { name: `Stop ${routeName}` });
    await stop.getByLabel('Why?').fill('Seasonal route');
    await stop.getByRole('button', { name: 'Stop the route' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'has a day that is not finished' })).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page.getByRole('heading', { name: /^VDY-\d{2}-\d{8}$/, level: 2 })).toBeVisible({ timeout: 60_000 });

    // Cancel it: a reason is needed; the visits can no longer be arranged and the history says so.
    await page.getByRole('button', { name: 'Cancel this day' }).click();
    const why = page.getByRole('form', { name: /^Cancel VDY-/ });
    await expect(why.getByRole('button', { name: 'Cancel the day' })).toBeDisabled();
    await why.getByLabel('Why?').fill('The customers are closed that day');
    await why.getByRole('button', { name: 'Cancel the day' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'is cancelled' })).toBeVisible({ timeout: 30_000 });
    await expect(day).toContainText('Cancelled');
    await expect(day).toContainText('Cancelled because: The customers are closed that day');
    await expect(page.getByRole('button', { name: 'Add a customer' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'History' })).toContainText('The day was cancelled');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // It is found among the cancelled days, and the route is free to plan again on the same date.
    await gotoAdmin(page, '/admin/van-sales/days', 'Van days');
    await page.getByRole('button', { name: 'Cancelled', exact: true }).click();
    await search(page, 'Search days', routeName);
    await expect(page.getByRole('listitem').filter({ hasText: routeName })).toContainText('Cancelled because: The customers are closed that day', { timeout: 30_000 });
    await planDay(page, routeName, date);
    await expect(page).toHaveURL(/\/admin\/van-sales\/days\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  });

  test('a day that does not exist shows the not-found page', async ({ page }) => {
    await page.goto('/admin/van-sales/days/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText(/could not be found|not found|doesn.t exist/i).first()).toBeVisible({ timeout: 60_000 });
  });
});

async function search(page: Page, label: string, text: string): Promise<void> {
  await expect(async () => {
    await page.getByRole('searchbox', { name: label }).fill(text);
    await expect(page.getByRole('searchbox', { name: label })).toHaveValue(text, { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
}
