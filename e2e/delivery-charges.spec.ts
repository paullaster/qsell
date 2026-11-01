import { expect, test, type Locator, type Page } from '@playwright/test';
import { estimatedRoadKm } from '../src/lib/geo';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';

const BRANCH_PIN = { latitude: -1.286389, longitude: 36.817223 };
const CUSTOMER_PIN = { latitude: -1.2195, longitude: 36.8895 };
const km = estimatedRoadKm(BRANCH_PIN, CUSTOMER_PIN, 1.3);
const money = (n: number): string => `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/**
 * Presses a button after bringing it to the middle of the screen. On a phone the development build's own badge sits over the bottom
 * corner and would take a click meant for a button scrolled to the edge.
 */
async function press(button: Locator): Promise<void> {
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await button.click();
}

/** A branch of our own with a map pin, so what we price touches nothing else. */
async function makeBranch(page: Page, code: string): Promise<void> {
  await open(page, '/admin/settings/branches', 'Branches');
  const add = page.getByRole('form', { name: 'Add branch' });
  await add.getByLabel('Code').fill(code);
  await add.getByLabel('Name').fill(`Charge ${code}`);
  await add.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.getByText(`Charge ${code} added.`)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Search branches').fill(code);
  const row = page.getByRole('list', { name: 'Branches' }).getByRole('listitem').filter({ hasText: `Charge ${code}` });
  await row.getByRole('button', { name: `Set the map pin for Charge ${code}` }).click();
  const pin = page.getByRole('form', { name: `Map pin for Charge ${code}` });
  await pin.getByLabel('Latitude').fill(String(BRANCH_PIN.latitude));
  await pin.getByLabel('Longitude').fill(String(BRANCH_PIN.longitude));
  await pin.getByRole('button', { name: 'Save pin' }).click();
  await expect(page.getByText(`Charge ${code} is now on the map.`)).toBeVisible({ timeout: 30_000 });
}

test.describe('delivery charges', () => {
  test('a policy by distance is written, refused when unsound, put in force with a reason, tried, versioned and replaced', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const code = `CH${tag}`;
    await makeBranch(page, `B${tag}`);

    await open(page, '/admin/delivery/charges', 'Delivery charges');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // A new policy by distance, for our branch only.
    await page.getByRole('button', { name: 'New policy' }).click();
    const form = page.getByRole('form', { name: 'New charge policy' });
    await form.getByLabel('Code').fill(code.toLowerCase());
    await form.getByRole('radio', { name: /By distance/ }).check();
    await form.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Give the policy a name.' })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Name', { exact: true }).fill(`Per km ${tag}`);

    // The one band may not end: every distance must have a fee. The words say so.
    const band = form.getByRole('listitem', { name: 'Band 1' });
    await band.getByLabel('Up to km').fill('5');
    await band.getByLabel('Base fee').fill('150');
    await band.getByLabel('For each km past the start').fill('20');
    await form.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The last distance band must have no upper limit' })).toBeVisible({ timeout: 30_000 });
    await band.getByLabel('Up to km').fill('');

    // Who it is for: our branch only.
    await form.getByRole('checkbox', { name: 'Branch' }).check();
    await expect(form.getByText('Pick at least one, or untick branch.')).toBeVisible();
    await pick(page, form.getByRole('combobox', { name: 'Add a branch' }), `B${tag}`, new RegExp(`B${tag}`));
    await expect(form.getByRole('list', { name: 'Branch chosen' })).toContainText(`Charge B${tag}`);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByText(`${code} version 1 saved as a draft.`)).toBeVisible({ timeout: 30_000 });

    // It is a draft; putting it in force needs a reason of a few words.
    await page.getByLabel('Search policies').fill(code);
    const list = page.getByRole('list', { name: 'Charge policies' });
    const row = list.getByRole('listitem').filter({ hasText: `Per km ${tag}` });
    await expect(row).toContainText('Draft');
    await expect(row).toContainText('Limited in 1 way');
    await row.getByRole('button', { name: `Put ${code} version 1 in force` }).click();
    const why = row.getByRole('form', { name: `Put ${code} version 1 in force` });
    await why.getByLabel('Why? (kept with the change)').fill('no');
    await expect(why.getByRole('button', { name: /^Confirm/ })).toBeDisabled();
    await why.getByLabel('Why? (kept with the change)').fill('First price for deliveries from this branch');
    await press(why.getByRole('button', { name: /^Confirm/ }));
    await expect(page.getByText(`${code} version 1 is in force.`)).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('In force');

    // Try a charge: the branch's pin to a customer's pin, worked out by the same rules an order uses.
    const sim = page.getByRole('region', { name: 'Try a delivery charge' });
    await pick(page, sim.getByRole('combobox', { name: 'Leaves from branch' }), `B${tag}`, new RegExp(`B${tag}`));
    await sim.getByLabel('Pin latitude (optional)').fill(String(CUSTOMER_PIN.latitude));
    await sim.getByLabel('Pin longitude (optional)').fill(String(CUSTOMER_PIN.longitude));
    await sim.getByRole('button', { name: 'Work out the charge' }).click();
    const expected = Math.round((150 + 20 * km) * 100) / 100;
    const charge = sim.getByRole('status', { name: 'The charge' });
    await expect(charge).toContainText(money(expected), { timeout: 30_000 });
    await expect(charge).toContainText(`Per km ${tag} (${code} v1)`);
    await expect(charge).toContainText(`${String(km)} km`);
    const steps = charge.getByRole('list', { name: 'How it was worked out' });
    await expect(steps).toContainText('Base fee from 0 km');
    await expect(steps).toContainText('KES 20 a km');

    // Without a pin or an address the map cannot measure, and the words say what is needed.
    await sim.getByLabel('Pin latitude (optional)').fill('');
    await sim.getByLabel('Pin longitude (optional)').fill('');
    await sim.getByRole('button', { name: 'Work out the charge' }).click();
    await expect(sim.getByRole('alert')).toContainText('map pin or an address that can be found on the map', { timeout: 30_000 });
    await noInnerHorizontalScroll(page);

    // A policy in force cannot be changed; a new version can. It replaces the first only when it goes in force.
    await row.getByRole('button', { name: `Open ${code} version 1` }).click();
    const viewing = page.getByRole('form', { name: `${code} version 1` });
    await expect(viewing.getByText('cannot be changed, so every past charge can still be explained')).toBeVisible({ timeout: 30_000 });
    await expect(viewing.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await press(viewing.getByRole('button', { name: 'Close' }));
    await row.getByRole('button', { name: `Make a new version of ${code}` }).click();
    await expect(page.getByText(`A draft of ${code} version 2 is ready to change.`)).toBeVisible({ timeout: 30_000 });
    const v2 = list.getByRole('listitem').filter({ hasText: 'version 2' });
    await v2.getByRole('button', { name: `Edit ${code} version 2` }).click();
    const edit = page.getByRole('form', { name: `${code} version 2` });
    await edit.getByRole('listitem', { name: 'Band 1' }).getByLabel('Base fee').fill('200');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`${code} version 2 saved as a draft.`)).toBeVisible({ timeout: 30_000 });
    await v2.getByRole('button', { name: `Put ${code} version 2 in force` }).click();
    await v2.getByRole('form', { name: `Put ${code} version 2 in force` }).getByLabel('Why? (kept with the change)').fill('Delivery now starts at 200');
    await press(v2.getByRole('form', { name: `Put ${code} version 2 in force` }).getByRole('button', { name: /^Confirm/ }));
    await expect(page.getByText(`${code} version 2 is in force.`)).toBeVisible({ timeout: 30_000 });

    await sim.getByLabel('Pin latitude (optional)').fill(String(CUSTOMER_PIN.latitude));
    await sim.getByLabel('Pin longitude (optional)').fill(String(CUSTOMER_PIN.longitude));
    await sim.getByRole('button', { name: 'Work out the charge' }).click();
    await expect(charge).toContainText(money(Math.round((200 + 20 * km) * 100) / 100), { timeout: 30_000 });
    await expect(charge).toContainText(`(${code} v2)`);

    // The first version was retired in the same step and is only listed on request.
    await expect(list.getByRole('listitem').filter({ hasText: 'version 1' })).toHaveCount(0);
    await page.getByRole('radio', { name: 'Retired' }).check();
    const retired = list.getByRole('listitem').filter({ hasText: 'version 1' });
    await expect(retired).toContainText('Retired', { timeout: 30_000 });
    await expect(retired.getByRole('button', { name: `Retire ${code} version 1` })).toHaveCount(0);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
