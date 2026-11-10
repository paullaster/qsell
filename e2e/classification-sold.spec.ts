import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';
import { attemptTag } from './support/vendors';

test.describe('whether a classification is sold to customers', () => {
  test('is named for what it does, asks before it changes the products, and applies only when confirmed', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const name = `Sold flag ${tag}`;

    await open(page, '/admin/item-types', /Business classifications/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(page.getByRole('columnheader', { name: 'Sold to customers' })).toBeVisible();

    await clickUntilVisible(page.getByRole('button', { name: 'Add business classification' }), page.getByRole('heading', { name: 'Create business classification' }));
    const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create business classification' }) });
    await form.getByPlaceholder('e.g. Finished product, Raw material').fill(name);
    await form.getByPlaceholder('e.g. 1').fill(String(100_000 + (Date.now() % 800_000)));
    // Named for what it does everywhere products are sold, not for the web shop alone.
    await expect(form.getByLabel('Sold to customers')).toBeChecked();
    await expect(form.getByText(/the web shop, quotes, orders and the invoices made from them/)).toBeVisible();
    await expect(form.getByText(/raw material/i)).toHaveCount(0);
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Yes');

    // Turning it off asks first, says what happens, and "Go back" changes nothing.
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Edit business classification' }) });
    await expect(edit).toBeVisible();
    await edit.getByLabel('Sold to customers').uncheck();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByText('Stop selling this classification?')).toBeVisible({ timeout: 30_000 });
    await expect(edit.getByText(/nothing else changes|will stop being sold/)).toBeVisible();
    await edit.getByRole('button', { name: 'Go back' }).click();
    await expect(edit.getByText('Stop selling this classification?')).toHaveCount(0);
    await noHorizontalScroll(page);

    // Confirmed, it is saved and the list says No.
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await edit.getByRole('button', { name: 'Yes, save and apply' }).click();
    await expect(row).toContainText('No', { timeout: 30_000 });
  });
});
