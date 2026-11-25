import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

/** What a printed heading shows about the business: for every report, for one module of reports, and on the cash sale receipt. */

test.describe('report headings', () => {
  test('are chosen for all reports, saved, and put back to the business name only', async ({ page }) => {
    await open(page, '/admin/settings/reports/general', 'All reports');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await clickUntilVisible(
      page.getByRole('button', { name: 'Standard letterhead' }),
      page.getByRole('checkbox', { name: /^Logo/ }).and(page.locator(':checked')),
    );
    await expect(page.getByLabel('How the heading will look')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();

    // Reports can be downloaded with the new heading.
    const pdf = await page.request.get('/api/admin/reports/stock-valuation/export?format=pdf');
    expect(pdf.status()).toBe(200);

    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^Logo/ })).toBeChecked({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Business name only' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();
  });

  test('a module follows the general heading until it is given its own', async ({ page }) => {
    await open(page, '/admin/settings/reports/sales', 'Sales reports');
    await noHorizontalScroll(page);
    const follow = page.getByRole('checkbox', { name: 'Use the heading of all reports' });
    await expect(follow).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^Logo/ })).toHaveCount(0);
    await follow.uncheck();
    await expect(page.getByRole('checkbox', { name: /^Logo/ })).toBeVisible();
  });

  test('a module that has no reports is not found', async ({ page }) => {
    const res = await page.goto('/admin/settings/reports/nothing-here');
    expect(res?.status()).toBe(404);
  });

  test('are listed under Settings with a screen for each module of reports', async ({ page }) => {
    await open(page, '/admin/settings/reports', /Reports/);
    await expect(page.getByRole('link', { name: /All reports/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Sales/ }).first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('cash sale receipt heading', () => {
  test('can show the business email, and is put back afterwards', async ({ page }) => {
    await open(page, '/admin/settings/sales/cash-sales', 'Cash Sales');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const email = page.getByRole('checkbox', { name: /^Email/ });
    await expect(email).toBeVisible({ timeout: 60_000 });
    const was = await email.isChecked();
    await email.setChecked(!was);
    const save = page.getByRole('region', { name: 'Business details on the receipt' }).getByRole('button', { name: 'Save' });
    await save.click();
    await expect(page.getByText(/Receipts print this heading/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^Email/ })).toBeChecked({ checked: !was, timeout: 60_000 });

    await page.getByRole('checkbox', { name: /^Email/ }).setChecked(was);
    await page.getByRole('region', { name: 'Business details on the receipt' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Receipts print this heading/)).toBeVisible();
  });
});
