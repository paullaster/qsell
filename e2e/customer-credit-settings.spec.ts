import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';

async function choose(page: Page, field: Locator, option: RegExp): Promise<void> {
  await expect(async () => {
    await field.click();
    await page.getByRole('option', { name: option }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('customer credit settings', () => {
  test('an admin changes what the credit figure shows, and it stays as saved', async ({ page }) => {
    test.slow();
    const path = '/admin/settings/sales/customer';
    await gotoAdmin(page, path, /^Customer$/);
    await expect(page.getByRole('heading', { name: 'Customer credit' })).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    await expect(page.getByText('Proceeding beyond available credit')).toBeVisible();
    await choose(page, page.getByRole('combobox', { name: 'Credit display' }), /^Static/);
    await page.getByRole('combobox', { name: /Reason/ }).first().click();
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Save display' }).click();
    await expect(page.getByText(/Saved\. The new display applies straight away\./)).toBeVisible({
      timeout: 30_000,
    });

    await gotoAdmin(page, path, /^Customer$/);
    await expect(page.getByRole('combobox', { name: 'Credit display' })).toHaveValue(/Static/);

    await choose(page, page.getByRole('combobox', { name: 'Credit display' }), /^Running/);
    await page.getByRole('combobox', { name: /Reason/ }).first().click();
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Save display' }).click();
    await expect(page.getByText(/Saved\. The new display applies straight away\./)).toBeVisible({
      timeout: 30_000,
    });
  });
});
