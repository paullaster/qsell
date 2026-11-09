import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';

test.describe('fuel and vehicle costs', () => {
  test('are typed in with what they were for, listed, counted in the report, and taken back with a reason', async ({ page }, testInfo) => {
    test.slow();
    const what = `Diesel ${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/delivery/costs', 'Delivery costs');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Record a running cost' });
    // Nothing can be saved until it says what kind, how much and what for.
    await expect(form.getByRole('button', { name: 'Save the cost' })).toBeDisabled();
    await pick(page, form.getByRole('combobox', { name: 'What kind of cost' }), 'Fuel', /^Fuel$/);
    await form.getByLabel('How much (KSh)').fill('2500.50');
    await form.getByLabel('What it was for').fill(what);
    await form.getByRole('button', { name: 'Save the cost' }).click();
    await expect(page.getByText('Saved. It counts against delivery in the report.')).toBeVisible({ timeout: 30_000 });
    // The form is empty again, ready for the next cost.
    await expect(page.getByRole('form', { name: 'Record a running cost' }).getByLabel('What it was for')).toHaveValue('');

    const list = page.getByRole('list', { name: 'Cost list' });
    const row = list.getByRole('listitem').filter({ hasText: what }).first();
    await expect(row).toContainText('Fuel', { timeout: 30_000 });
    await expect(row).toContainText('2500.50');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The report counts it against delivery.
    await open(page, '/admin/delivery/reports', 'Delivery report');
    await expect(page.getByRole('region', { name: 'Margin' })).toContainText(/fuel \d/, { timeout: 30_000 });

    // A mistake is taken back with a reason; the entry stays.
    await open(page, '/admin/delivery/costs', 'Delivery costs');
    const again = list.getByRole('listitem').filter({ hasText: what }).first();
    await again.getByLabel('Why it is being taken back').fill('Typed twice by mistake');
    await again.getByRole('button', { name: /^Take back the fuel/ }).click();
    await again.getByRole('button', { name: /^Confirm: Take back/ }).click();
    await expect(page.getByText('The cost is taken back.')).toBeVisible({ timeout: 30_000 });
    await expect(list).toContainText('Was taken back');
  });
});
