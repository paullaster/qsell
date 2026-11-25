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

/** Both modes are switched on, whichever test ran first (they share one database). */
async function modesOn(page: Page): Promise<void> {
  await gotoAdmin(page, '/admin/settings/sales/van-sales', 'Van sales');
  const form = page.getByRole('form', { name: 'Van sales' });
  const van = form.getByRole('checkbox', { name: /^Van sell/ });
  const pre = form.getByRole('checkbox', { name: /^Pre-sell/ });
  await expect(van).toBeVisible({ timeout: 60_000 });
  if ((await van.isChecked()) && (await pre.isChecked())) return;
  await expect(async () => {
    if (!(await van.isChecked())) await van.check();
    if (!(await pre.isChecked())) await pre.check();
    await expect(van).toBeChecked({ timeout: 3000 });
    await expect(pre).toBeChecked({ timeout: 3000 });
  }).toPass({ timeout: 120_000 });
  await expect(async () => {
    await form.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click({ timeout: 4000 });
    await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 3000 });
  }).toPass({ timeout: 120_000 });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. Van sales now follows these rules.')).toBeVisible({ timeout: 30_000 });
}

const search = async (page: Page, label: string, text: string): Promise<void> => {
  await expect(async () => {
    await page.getByRole('searchbox', { name: label }).fill(text);
    await expect(page.getByRole('searchbox', { name: label })).toHaveValue(text, { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
};

test.describe('van sales: routes', () => {
  test('a route is added, opened, given customers with days and an order, usual stock, a date to see who is due, changed, stopped and used again', async ({ page }, testInfo) => {
    test.slow();
    const tag = `rt${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const routeName = `Kiambu ${tag}`;
    const shops = vanTool('customer', tag, '3').names?.split('|') ?? [];
    const soda = vanTool('product', tag).name ?? '';
    expect(shops).toHaveLength(3);
    await modesOn(page);

    // Add the route.
    await gotoAdmin(page, '/admin/van-sales/routes', 'Routes');
    await noNativeSelect(page);
    const add = page.getByRole('form', { name: 'New route' });
    await open(page.getByRole('button', { name: 'Add a route' }), add);
    await add.getByLabel('Route code').fill(`k-${tag}`);
    await add.getByLabel('Route name').fill(routeName);
    await chooseFirst(page, add.getByRole('combobox', { name: /Branch/ }));
    await add.getByRole('radio', { name: /Van sell and pre-sell/ }).check();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await noNativeSelect(page);
    await add.getByRole('button', { name: 'Add the route' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${routeName} added` })).toBeVisible({ timeout: 30_000 });
    await search(page, 'Search routes', routeName);
    const row = page.getByRole('listitem').filter({ hasText: routeName });
    await expect(row).toContainText('0 customers');
    await expect(row).toContainText(`K-${tag}`.toUpperCase());

    // Open it by soft navigation, as a person would.
    await expect(async () => {
      await row.getByRole('link', { name: `Open route ${routeName}` }).click();
      await expect(page.getByRole('heading', { name: routeName, level: 2 })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 120_000 });
    await expect(page).toHaveURL(/\/admin\/van-sales\/routes\/[0-9a-f-]{36}$/);

    // Put three customers on it: the first on Mondays, the second on Mondays every 2 weeks, the third on Wednesdays.
    const customers = page.getByRole('region', { name: 'Customers on this route' });
    for (const [i, shop] of shops.entries()) {
      const form = page.getByRole('form', { name: 'Add a customer to the route' });
      await open(customers.getByRole('button', { name: 'Add a customer' }), form);
      await chooseFirst(page, form.getByRole('combobox', { name: /Customer/ }), shop);
      // A day is needed first.
      if (i === 0) {
        await form.getByRole('button', { name: 'Put on the route' }).click();
        await expect(form.getByRole('alert')).toContainText('at least one day', { timeout: 30_000 });
      }
      await form.getByLabel(i === 2 ? 'Wednesday' : 'Monday').check();
      if (i === 1) await form.getByRole('radio', { name: 'Every 2 weeks' }).check();
      await form.getByLabel('Visits start from').fill('2026-11-02');
      await form.getByRole('button', { name: 'Put on the route' }).click();
      await expect(page.getByRole('status').filter({ hasText: `${shop} is on the route` })).toBeVisible({ timeout: 30_000 });
    }
    const stops = customers.getByRole('listitem');
    await expect(stops).toHaveCount(3);
    await expect(stops.nth(0)).toContainText(shops[0] ?? '');
    await expect(stops.nth(1)).toContainText('Mon, every 2 weeks');
    await expect(stops.nth(2)).toContainText('Wed');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A customer already on the route is not offered again.
    await open(customers.getByRole('button', { name: 'Add a customer' }), page.getByRole('form', { name: 'Add a customer to the route' }));
    const picker = page.getByRole('form', { name: 'Add a customer to the route' }).getByRole('combobox', { name: /Customer/ });
    await picker.click();
    await picker.fill(shops[0] ?? '');
    await expect(page.getByRole('option', { name: new RegExp(shops[0] ?? '') })).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole('form', { name: 'Add a customer to the route' }).getByRole('button', { name: 'Cancel' }).click();

    // Order of the round: the third moves up one place, then the first moves down.
    await customers.getByRole('button', { name: `Move ${shops[2] ?? ''} up` }).click();
    await expect(page.getByRole('status').filter({ hasText: `${shops[2] ?? ''} moved up` })).toBeVisible({ timeout: 30_000 });
    await expect(stops.nth(1)).toContainText(shops[2] ?? '');
    await expect(customers.getByRole('button', { name: `Move ${shops[0] ?? ''} up` })).toBeDisabled();

    // Change one customer's days.
    await customers.getByRole('button', { name: `Change the visits to ${shops[2] ?? ''}` }).click();
    const change = page.getByRole('form', { name: `Change the visits to ${shops[2] ?? ''}` });
    await change.getByLabel('Wednesday').uncheck();
    await change.getByLabel('Friday').check();
    await change.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: `The visits to ${shops[2] ?? ''} are saved` })).toBeVisible({ timeout: 30_000 });
    await expect(stops.nth(1)).toContainText('Fri');

    // Take one off: the rest close up.
    const confirmTakeOff = customers.getByRole('button', { name: `Confirm: Take ${shops[1] ?? ''} off this route` });
    await open(customers.getByRole('button', { name: `Take ${shops[1] ?? ''} off this route` }), confirmTakeOff);
    // Press until the result shows (a press can land as the list redraws); once it has worked the button is gone, so it never acts twice.
    await expect(async () => {
      if (await confirmTakeOff.isVisible()) await confirmTakeOff.click();
      await expect(page.getByRole('status').filter({ hasText: `${shops[1] ?? ''} is off the route` })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(stops).toHaveCount(2);

    // Usual stock: a product with a quantity, a fraction is refused for a product counted in whole pieces, then saved.
    const par = page.getByRole('region', { name: 'Usual stock of the van' });
    await chooseFirst(page, par.getByRole('combobox', { name: /Product/ }), soda);
    await par.getByLabel('Quantity', { exact: true }).fill('24.5');
    await par.getByRole('button', { name: 'Add to the list' }).click();
    await par.getByRole('button', { name: 'Save the usual stock' }).click();
    await expect(par.getByRole('alert')).toContainText('must be a whole number', { timeout: 30_000 });
    await par.getByLabel(`Quantity of ${soda}`).fill('24');
    await par.getByRole('button', { name: 'Save the usual stock' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The usual stock is saved' })).toBeVisible({ timeout: 30_000 });
    await expect(par.getByLabel(`Quantity of ${soda}`)).toHaveValue('24');
    await expect(par.getByLabel(`Quantity of ${soda}`)).toBeVisible();
    await expect(par.getByText('Piece', { exact: true })).toBeVisible();

    // Who is due: Monday 9 November has the first customer only (the fortnightly one was taken off); Friday 6 November the second.
    const due = page.getByRole('region', { name: 'Who is due on a day' });
    await due.getByLabel('Date').fill('2026-11-09');
    await expect(due.getByTestId('due-count')).toContainText('Monday: 1 customer due', { timeout: 30_000 });
    await expect(due.getByRole('list', { name: 'Due on this day' })).toContainText(shops[0] ?? '');
    await due.getByLabel('Date').fill('2026-11-06');
    await expect(due.getByTestId('due-count')).toContainText('Friday: 1 customer due', { timeout: 30_000 });
    await due.getByLabel('Date').fill('2026-11-07');
    await expect(due.getByTestId('due-count')).toContainText('nobody is due', { timeout: 30_000 });

    // Change the route's name, then stop it (a reason is needed) and use it again.
    await page.getByRole('button', { name: 'Change the route' }).click();
    const edit = page.getByRole('form', { name: `Change ${routeName}` });
    await expect(edit.getByLabel('Branch')).toHaveAttribute('readonly', '');
    await edit.getByLabel('Route name').fill(`${routeName} north`);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: `${routeName} north`, level: 2 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Stop this route' }).click();
    const why = page.getByRole('form', { name: `Stop ${routeName} north` });
    await expect(why.getByRole('button', { name: 'Stop the route' })).toBeDisabled();
    await why.getByLabel('Why?').fill('Only runs in the dry season');
    await why.getByRole('button', { name: 'Stop the route' }).click();
    await expect(page.getByText('Stopped because: Only runs in the dry season')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Add a customer' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Use again' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'is in use again' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Add a customer' })).toBeVisible();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await noNativeSelect(page);
  });

  test('a route that does not exist shows the not-found page', async ({ page }) => {
    await page.goto('/admin/van-sales/routes/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText(/could not be found|not found|doesn.t exist/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
