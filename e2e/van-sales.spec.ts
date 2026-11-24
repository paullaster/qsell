import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { riderTool } from './support/rider-fixtures';

/** Takes the first option a picker offers (the page is drawn before it is wired up, so try until it takes). */
async function chooseFirst(page: Page, field: Locator, text = ''): Promise<void> {
  await expect(async () => {
    await field.click();
    if (text !== '') await field.fill(text);
    await page.getByRole('option').first().click({ timeout: 4000 });
  }).toPass({ timeout: 120_000 });
}

/** Presses a button until the thing it opens is there. */
async function open(trigger: Locator, target: Locator): Promise<void> {
  await expect(async () => {
    await trigger.click();
    await expect(target).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000 });
}

const search = async (page: Page, label: string, text: string): Promise<void> => {
  await expect(async () => {
    await page.getByRole('searchbox', { name: label }).fill(text);
    await expect(page.getByRole('searchbox', { name: label })).toHaveValue(text, { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
};

test.describe('van sales: vans and sales reps', () => {
  test('the home leads to vans and reps; a van is added with its stock place and till, refused a repeated name, changed, stopped with a reason, found among the stopped, and used again', async ({ page }, testInfo) => {
    test.slow();
    const tag = `vn${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const name = `Van ${tag}`;
    const renamed = `Van ${tag} north`;

    await gotoAdmin(page, '/admin/van-sales', 'Van sales');
    await expect(page.getByRole('region', { name: 'Vans' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Sales reps' })).toBeVisible();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    // Soft navigation from the home, as a person would.
    await expect(async () => {
      await page.getByRole('link', { name: 'Open vans' }).click();
      await expect(page.getByRole('heading', { name: 'Vans', level: 1 })).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 120_000 });
    await expect(page).toHaveURL(/\/admin\/van-sales\/vans$/);
    await noNativeSelect(page);

    // Add one.
    const add = page.getByRole('form', { name: 'New van' });
    await open(page.getByRole('button', { name: 'Add a van' }), add);
    await add.getByLabel(/Name or plate/).fill(name);
    await chooseFirst(page, add.getByRole('combobox', { name: /Branch/ }));
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await add.getByRole('button', { name: 'Add the van' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} added` })).toBeVisible({ timeout: 30_000 });
    await search(page, 'Search vans', name);
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('In use', { timeout: 30_000 });
    await expect(row).toContainText(/VAN-VN/i);
    await expect(row).toContainText('Stock on the van');

    // The same name again is refused in words, and nothing is added.
    await open(page.getByRole('button', { name: 'Add a van' }), add);
    await add.getByLabel(/Name or plate/).fill(name.toUpperCase());
    await chooseFirst(page, add.getByRole('combobox', { name: /Branch/ }));
    await add.getByRole('button', { name: 'Add the van' }).click();
    await expect(add.getByRole('alert')).toContainText('already exists', { timeout: 30_000 });
    await add.getByRole('button', { name: 'Cancel' }).click();

    // Change it.
    await row.getByRole('button', { name: `Change ${name}` }).click();
    const change = page.getByRole('form', { name: `Change ${name}` });
    await expect(change).toBeVisible();
    await expect(change.getByLabel('Branch')).toHaveAttribute('readonly', '');
    await change.getByLabel(/Name or plate/).fill(renamed);
    await change.getByLabel(/Most cash the van should hold/).fill('75000');
    await change.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${renamed} saved` })).toBeVisible({ timeout: 30_000 });
    await search(page, 'Search vans', renamed);
    const changed = page.getByRole('listitem').filter({ hasText: renamed });
    await expect(changed).toContainText('KES 75,000');

    // Stop it: a reason is needed, then it moves to the stopped list.
    await changed.getByRole('button', { name: `Stop ${renamed}` }).click();
    const why = page.getByRole('form', { name: `Stop ${renamed}` });
    await expect(why.getByRole('button', { name: 'Stop the van' })).toBeDisabled();
    await why.getByLabel('Why?').fill('Sold at the end of the lease');
    await why.getByRole('button', { name: 'Stop the van' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${renamed} is stopped` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: renamed })).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Stopped', exact: true }).click();
    const stopped = page.getByRole('listitem').filter({ hasText: renamed });
    await expect(stopped).toContainText('Stopped because: Sold at the end of the lease', { timeout: 30_000 });

    // And in use again.
    await stopped.getByRole('button', { name: 'Use again' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${renamed} is in use again` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'In use', exact: true }).click();
    await search(page, 'Search vans', renamed);
    await expect(page.getByRole('listitem').filter({ hasText: renamed })).toContainText('In use', { timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('a member of staff is made a sales rep with limits, is refused when already one, paused and ended with reasons, and put back to work', async ({ page }, testInfo) => {
    test.slow();
    const tag = `rp${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const person = riderTool('staff', tag);
    const name = person.name ?? '';

    await gotoAdmin(page, '/admin/van-sales/reps', 'Sales reps');
    await noNativeSelect(page);
    const add = page.getByRole('form', { name: 'New sales rep' });
    await open(page.getByRole('button', { name: 'Add a sales rep' }), add);
    await chooseFirst(page, add.getByRole('combobox', { name: /Member of staff/ }), name);
    await add.getByLabel(/^Phone/).fill('+254 711 000 222');
    await add.getByLabel(/Most discount the rep may give/).fill('5');
    await add.getByLabel(/Most credit in one day/).fill('20000');
    await add.getByLabel('May sell on credit').check();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // At least one thing they do is needed.
    await add.getByLabel('Van sell').uncheck();
    await add.getByLabel('Pre-sell').uncheck();
    await add.getByRole('button', { name: 'Add the sales rep' }).click();
    await expect(add.getByRole('alert')).toContainText('what the rep does', { timeout: 30_000 });
    await add.getByLabel('Pre-sell').check();
    await add.getByRole('button', { name: 'Add the sales rep' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} is now a sales rep` })).toBeVisible({ timeout: 30_000 });

    await search(page, 'Search sales reps', name);
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('Selling', { timeout: 30_000 });
    await expect(row).toContainText('Pre-sell');
    await expect(row).toContainText('5%');
    await expect(row).toContainText('KES 20,000');
    await expect(row).toContainText('Not allowed'); // changing a price

    // They are no longer offered as someone to add.
    await open(page.getByRole('button', { name: 'Add a sales rep' }), add);
    await add.getByRole('combobox', { name: /Member of staff/ }).click();
    await add.getByRole('combobox', { name: /Member of staff/ }).fill(name);
    await expect(page.getByRole('option', { name })).toHaveCount(0, { timeout: 15_000 });
    await add.getByRole('button', { name: 'Cancel' }).click();

    // Pause (a reason is needed), then end, then back to work.
    await row.getByRole('button', { name: `Pause ${name}` }).click();
    const pause = page.getByRole('form', { name: `Pause ${name}` });
    await expect(pause.getByRole('button', { name: 'Pause' })).toBeDisabled();
    await pause.getByLabel('Why?').fill('On leave until March');
    await pause.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} is paused` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Paused', exact: true }).click();
    const paused = page.getByRole('listitem').filter({ hasText: name });
    await expect(paused).toContainText('Paused because: On leave until March', { timeout: 30_000 });
    await paused.getByRole('button', { name: `End ${name}` }).click();
    const end = page.getByRole('form', { name: `End ${name}` });
    await end.getByLabel('Why?').fill('Left the company');
    await end.getByRole('button', { name: 'End their work as a rep' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} no longer sells` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Ended', exact: true }).click();
    const ended = page.getByRole('listitem').filter({ hasText: name });
    await expect(ended).toContainText('Ended because: Left the company', { timeout: 30_000 });
    await expect(ended.getByRole('button', { name: `Change ${name}` })).toHaveCount(0);
    await ended.getByRole('button', { name: 'Put back to work' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} is selling again` })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
