import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { makeLimitedProduct } from './support/storefront-fixtures';

/** Types into a picker and takes the option the server found. */
async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('packages', () => {
  test('a package is made from products, shows what is in it, can be changed and removed, with a reason each time', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pk${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const lunch = makeLimitedProduct(`${tag}L`, 1, 5);
    const small = makeLimitedProduct(`${tag}S`, 1, 5);
    const large = makeLimitedProduct(`${tag}G`, 1, 5);
    const ugali = makeLimitedProduct(`${tag}U`, 1, 5);

    await open(page, '/admin/pricing/packages', 'Packages');
    await expect(page.getByRole('button', { name: 'New package' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'New package' }).click();
    const form = page.getByRole('form', { name: 'New package' });
    await expect(form).toBeVisible();

    await pick(page, form.getByRole('combobox', { name: /Product sold as the package/ }), lunch.name);
    await form.getByLabel('Name of slot 1').fill('Fish');
    await pick(page, form.getByRole('combobox', { name: /Product, slot 1 option 1/ }), small.name);
    await form.getByRole('button', { name: 'Add an option' }).first().click();
    await pick(page, form.getByRole('combobox', { name: /Product, slot 1 option 2/ }), large.name);
    await form.getByLabel('Difference, slot 1 option 2').fill('120');
    await form.getByRole('button', { name: 'Add a slot' }).click();
    await form.getByLabel('Name of slot 2').fill('Starch');
    await pick(page, form.getByRole('combobox', { name: /Product, slot 2 option 1/ }), ugali.name);

    // Nothing is saved without a reason.
    await expect(form.getByRole('button', { name: 'Save package' })).toBeDisabled();
    await form.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await expect(form.getByRole('button', { name: 'Save package' })).toBeEnabled();
    await form.getByRole('button', { name: 'Save package' }).click();
    await expect(page.getByText('Package made. It applies to the next order.')).toBeVisible({ timeout: 30_000 });

    const card = page.getByRole('listitem').filter({ hasText: lunch.name }).first();
    await expect(card).toContainText('Fish');
    await expect(card).toContainText(small.name);
    await expect(card).toContainText(large.name);
    await expect(card).toContainText('Starch');
    await expect(card).toContainText('In use');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Changing it: a slot can be taken out again, and the change needs a reason too.
    await card.getByRole('button', { name: `Change ${lunch.name}` }).click();
    const change = page.getByRole('form', { name: 'Change package' });
    await expect(change).toBeVisible();
    await change.getByRole('button', { name: 'Remove slot 2' }).click();
    await change.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await change.getByRole('button', { name: 'Save package' }).click();
    await expect(page.getByText('Package saved. It applies to the next order.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: lunch.name }).first()).not.toContainText('Starch');

    // Removing it asks first, and the product is ordinary again.
    await page.getByRole('listitem').filter({ hasText: lunch.name }).first().getByRole('button', { name: `Change ${lunch.name}` }).click();
    const again = page.getByRole('form', { name: 'Change package' });
    await again.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await again.getByRole('button', { name: /^Remove the package/ }).click();
    await again.getByRole('button', { name: /^Confirm: Remove the package/ }).click();
    await expect(page.getByText('Package removed. The product is an ordinary product again.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: lunch.name })).toHaveCount(0);
  });
});
