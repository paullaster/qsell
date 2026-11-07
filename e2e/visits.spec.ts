import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { riderTool } from './support/rider-fixtures';

/** The text a date-time box takes, for some days from now at a whole hour. */
const boxTime = (days: number, hour: number): string => {
  const d = new Date(Date.now() + days * 86_400_000 + 3 * 3_600_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};

test.describe('visits', () => {
  test('an office books a visit for a paid order, names the crew, and the crew ticks the checklist, does the work and has it signed off', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const orderNumber = riderTool('paid-order', tag).orderNumber ?? '';
    const crewMember = riderTool('staff', tag);
    const crewName = crewMember.name ?? '';
    await open(page, '/admin/delivery/visits', 'Visits');
    await noNativeSelect(page);

    const form = page.getByRole('form', { name: 'Book a visit' });
    await pick(page, form.getByRole('combobox', { name: 'Order' }), orderNumber, new RegExp(orderNumber));
    // A visit in the past is refused, in words.
    await form.getByLabel('Starts (Nairobi time)').fill(boxTime(-1, 8));
    await form.getByLabel('Ends (Nairobi time)').fill(boxTime(-1, 10));
    await form.getByLabel('Address the crew goes to').fill('Kileleshwa, Nairobi, Gate 4');
    await form.getByLabel('Checklist, one item to a line').fill('Fit the unit\nTest it');
    await form.getByRole('button', { name: 'Book the visit' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /must start in the future/ })).toBeVisible({ timeout: 30_000 });

    await form.getByLabel('Starts (Nairobi time)').fill(boxTime(2, 8));
    await form.getByLabel('Ends (Nairobi time)').fill(boxTime(2, 11));
    await form.getByRole('button', { name: 'Book the visit' }).click();
    await expect(page.getByText('The visit is booked.')).toBeVisible({ timeout: 30_000 });

    const card = page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
    await expect(card).toContainText('Booked', { timeout: 30_000 });
    await expect(card).toContainText('No crew yet.');
    await expect(card).toContainText('0 of 2 ticked');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The crew cannot be on site before it is named.
    await expect(card.getByRole('button', { name: 'Crew is on site' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Name the crew' }).click();
    const crewForm = card.getByRole('form', { name: `Crew for order ${orderNumber}` });
    await pick(page, crewForm.getByRole('combobox', { name: 'Add a person' }), crewName, new RegExp(crewName));
    await expect(crewForm.getByRole('list', { name: 'Crew chosen' })).toContainText(crewName);
    await crewForm.getByRole('button', { name: 'Save the crew' }).click();
    await expect(page.getByText('The crew is set.')).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(`Crew: ${crewName}`, { timeout: 30_000 });
    await expect(card).toContainText('Crew assigned');

    // The checklist can be ticked only once the crew is on site, and the work is done only when every item is.
    const first = card.getByRole('checkbox', { name: 'Fit the unit' });
    await expect(first).toBeDisabled();
    await card.getByRole('button', { name: 'Crew is on site' }).click();
    await expect(card).toContainText('On site', { timeout: 30_000 });

    // Materials: taken from stock while on site, refused when there is not enough, and given back with a reason.
    const used = card.getByRole('form', { name: `Use a material on order ${orderNumber}` });
    await pick(page, used.getByRole('combobox', { name: 'Material' }), 'Salt 500g', /Salt 500g/);
    await used.getByLabel('How much was used').fill('100000');
    await used.getByRole('button', { name: 'Take it from stock' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /more than nothing|not enough stock/ })).toBeVisible({ timeout: 30_000 });
    await used.getByLabel('How much was used').fill('2');
    await used.getByRole('button', { name: 'Take it from stock' }).click();
    await expect(page.getByText('The material is recorded and taken from stock.')).toBeVisible({ timeout: 30_000 });
    const materials = card.getByRole('list', { name: `Materials list for order ${orderNumber}` });
    await expect(materials).toContainText('Used 2 × Salt 500g', { timeout: 30_000 });
    await materials.getByLabel('Why it is being given back').fill('Not needed after all');
    await materials.getByRole('button', { name: 'Give back Salt 500g' }).click();
    await materials.getByRole('button', { name: 'Confirm: Give back Salt 500g' }).click();
    await expect(page.getByText('The material is back in stock.')).toBeVisible({ timeout: 30_000 });
    await expect(materials).toContainText('Was given back', { timeout: 30_000 });
    await expect(materials).toContainText('Given back 2 × Salt 500g');
    await card.getByRole('button', { name: 'Mark the work done' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '2 items are not ticked on the checklist yet.' })).toBeVisible({ timeout: 30_000 });
    await card.getByRole('checkbox', { name: 'Fit the unit' }).click();
    await expect(card).toContainText('1 of 2 ticked', { timeout: 30_000 });
    await card.getByRole('checkbox', { name: 'Test it' }).click();
    await expect(card).toContainText('2 of 2 ticked', { timeout: 30_000 });
    await card.getByRole('button', { name: 'Mark the work done' }).click();
    await expect(card).toContainText('Done, waiting for sign-off', { timeout: 30_000 });

    await card.getByRole('button', { name: /sign-off/ }).click();
    const sign = card.getByRole('form', { name: `Sign-off for order ${orderNumber}` });
    await sign.getByLabel('Who signed the work off for the customer').fill('M');
    await sign.getByRole('button', { name: 'Record the sign-off' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Say who signed the work off' })).toBeVisible({ timeout: 30_000 });
    await sign.getByLabel('Who signed the work off for the customer').fill('Mama Wanjiku');
    await sign.getByRole('button', { name: 'Record the sign-off' }).click();
    await expect(page.getByText('Signed off. The order is delivered.')).toBeVisible({ timeout: 30_000 });

    // It leaves the coming-up list and is found under Signed off.
    await expect(page.getByRole('list', { name: 'Visit list' }).getByText(`Order ${orderNumber}`)).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Signed off' }).click();
    const done = page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
    await expect(done).toContainText('signed off by Mama Wanjiku', { timeout: 30_000 });
    await expect(done.getByRole('button', { name: /^Cancel the visit/ })).toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('a visit can be moved with a reason, and cancelled with one', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}M`;
    const orderNumber = riderTool('paid-order', tag).orderNumber ?? '';
    await open(page, '/admin/delivery/visits', 'Visits');
    const form = page.getByRole('form', { name: 'Book a visit' });
    await pick(page, form.getByRole('combobox', { name: 'Order' }), orderNumber, new RegExp(orderNumber));
    await form.getByLabel('Starts (Nairobi time)').fill(boxTime(3, 9));
    await form.getByLabel('Ends (Nairobi time)').fill(boxTime(3, 12));
    await form.getByLabel('Address the crew goes to').fill('Westlands, Nairobi');
    await form.getByLabel('Checklist, one item to a line').fill('Measure up');
    await form.getByRole('button', { name: 'Book the visit' }).click();
    const card = page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
    await expect(card).toContainText('Booked', { timeout: 30_000 });

    await card.getByRole('button', { name: 'Move the visit' }).click();
    const move = card.getByRole('form', { name: `Move the visit for order ${orderNumber}` });
    await move.getByLabel('New start (Nairobi time)').fill(boxTime(4, 9));
    await move.getByLabel('New end (Nairobi time)').fill(boxTime(4, 12));
    await move.getByLabel('Why it is being moved').fill('no');
    await move.getByRole('button', { name: 'Move it' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Say why the visit is moved/ })).toBeVisible({ timeout: 30_000 });
    await move.getByLabel('Why it is being moved').fill('Customer asked for a later day');
    await move.getByRole('button', { name: 'Move it' }).click();
    await expect(page.getByText('The visit is moved.')).toBeVisible({ timeout: 30_000 });
    // The card is rebuilt from the saved visit; cancelling before that would use the old version.
    await expect(move).toHaveCount(0, { timeout: 30_000 });

    await card.getByLabel('Why it is being cancelled').fill('Customer is travelling');
    await card.getByRole('button', { name: `Cancel the visit for order ${orderNumber}` }).click();
    await card.getByRole('button', { name: `Confirm: Cancel the visit for order ${orderNumber}` }).click();
    await expect(page.getByText('The visit is cancelled.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancelled' }).click();
    const gone = page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
    await expect(gone).toContainText('cancelled: Customer is travelling', { timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
