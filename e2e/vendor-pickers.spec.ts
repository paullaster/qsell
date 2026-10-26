import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

/** A vendor picker on a payables screen offers to add a vendor or to see them all, in windows over the form: the form is not lost. */
test.describe('vendor pickers', () => {
  test('"View all vendors" and "Add a vendor" open over the payment form, and a direct address shows the same list as a page', async ({ page }) => {
    test.slow();
    await open(page, '/admin/vendors/payments/new', 'New payment');
    await noNativeSelect(page);
    const vendor = page.getByRole('combobox', { name: 'Vendor' });
    // One click: another would close the list again.
    await vendor.click();
    await expect(page.getByRole('link', { name: 'View all vendors' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'View all vendors' }).click();
    await expect(page).toHaveURL(/\/admin\/vendors\/browse$/, { timeout: 60_000 });
    const dialog = page.getByRole('dialog', { name: 'All vendors' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    // The payment form is still underneath, and Escape returns to it.
    await expect(page.getByRole('heading', { name: 'New payment' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/admin\/vendors\/payments\/new$/, { timeout: 30_000 });
    await expect(dialog).toHaveCount(0);

    // One click: another would close the list again.
    await vendor.click();
    await expect(page.getByRole('link', { name: 'Add a vendor' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'Add a vendor' }).click();
    await expect(page).toHaveURL(/\/admin\/vendors\/new$/, { timeout: 60_000 });
    await expect(page.getByRole('dialog', { name: 'Add a vendor' })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/admin\/vendors\/payments\/new$/, { timeout: 30_000 });

    // On its own address the list is a page.
    await open(page, '/admin/vendors/browse', 'Vendors');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await noHorizontalScroll(page);
  });
});
