import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('delivery methods', () => {
  test('a branch offers a method with a preparation time, keeps it after a reload, and turns it off again', async ({ page }, testInfo) => {
    const code = `D${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    // Add a branch of our own to work on, so nothing else is disturbed.
    await open(page, '/admin/settings/branches', 'Branches');
    const add = page.getByRole('form', { name: 'Add branch' });
    await add.getByLabel('Code').fill(code);
    await add.getByLabel('Name').fill(`Deliver ${code}`);
    await add.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText(`Deliver ${code} added.`)).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/delivery/methods', 'Delivery methods');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByLabel('Search branches').fill(code);
    const branch = page.getByRole('list', { name: 'Branches' }).getByRole('listitem').filter({ hasText: `Deliver ${code}` });
    await expect(branch).toBeVisible({ timeout: 30_000 });

    // Everything starts off, and the time and note cannot be set on a method that is off.
    const pickup = branch.getByRole('form', { name: `Customer collects at Deliver ${code}` });
    await expect(pickup.getByRole('checkbox', { name: 'Customer collects' })).not.toBeChecked();
    await expect(pickup.getByLabel('Time to prepare (minutes)')).toBeDisabled();
    await expect(pickup.getByRole('button', { name: /^Save/ })).toBeDisabled();

    await pickup.getByRole('checkbox', { name: 'Customer collects' }).check();
    await pickup.getByLabel('Time to prepare (minutes)').fill('90');
    await expect(pickup).toContainText('1 h 30 min');
    await pickup.getByLabel('Note for staff (optional)').fill('Collect at the front desk');
    await pickup.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText(`Customer collects at Deliver ${code} saved.`)).toBeVisible({ timeout: 30_000 });

    // A time that is not a number of minutes is refused in words.
    await pickup.getByLabel('Time to prepare (minutes)').fill('soon');
    await pickup.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'whole number of minutes' })).toBeVisible({ timeout: 30_000 });

    // It is still there after a reload.
    await open(page, '/admin/delivery/methods', 'Delivery methods');
    await page.getByLabel('Search branches').fill(code);
    const again = page.getByRole('list', { name: 'Branches' }).getByRole('listitem').filter({ hasText: `Deliver ${code}` }).getByRole('form', { name: `Customer collects at Deliver ${code}` });
    await expect(again.getByRole('checkbox', { name: 'Customer collects' })).toBeChecked({ timeout: 30_000 });
    await expect(again.getByLabel('Time to prepare (minutes)')).toHaveValue('90');
    await expect(again.getByLabel('Note for staff (optional)')).toHaveValue('Collect at the front desk');
    await noInnerHorizontalScroll(page);

    await again.getByRole('checkbox', { name: 'Customer collects' }).uncheck();
    await again.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText(`Customer collects at Deliver ${code} saved.`).first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
