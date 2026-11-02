import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { attemptTag } from './support/vendors';

test.describe('a classification that behaves as a service', () => {
  test('is made on the classifications screen, gives a new product the service treatment without a cost or a selling price, and is the only kind delivery can be billed as', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const name = `Delivery work ${tag}`;
    deliveryTool('service', 'ensure');

    // The classification: it says its products are services, and it is still sellable on the storefront.
    await open(page, '/admin/item-types', /Business classifications/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await clickUntilVisible(page.getByRole('button', { name: 'Add business classification' }), page.getByRole('heading', { name: 'Create business classification' }));
    const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create business classification' }) });
    await form.getByPlaceholder('e.g. Finished product, Raw material').fill(name);
    await form.getByPlaceholder('e.g. 1').fill(String(100_000 + (Date.now() % 800_000)));
    await pick(page, form.getByRole('combobox', { name: 'Products of this classification behave as' }), 'Service', /^Service/);
    await expect(form.getByText(/A service needs no cost of goods/)).toBeVisible();
    // It stays "sellable on storefront": being a service is what removes the need for a price, not unticking that.
    await noNativeSelect(page);
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Service');
    await noInnerHorizontalScroll(page);

    // A new product under it starts as a service: no stock, and no cost of goods asked for.
    await open(page, '/admin/products', /Products|Catalog/);
    const dialog = page.getByRole('dialog');
    // The product form is a large screen: the first time, the development server can take longer than a few seconds to produce it.
    await expect(async () => {
      await page.getByRole('button', { name: 'Add New Product' }).click({ timeout: 10_000 });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
    }).toPass({ timeout: 150_000 });
    await pick(page, dialog.getByRole('combobox', { name: 'Business classification' }), name, new RegExp(name));
    await dialog.getByRole('button', { name: 'Stock behaviour' }).click();
    await expect(dialog.getByRole('combobox', { name: 'How should qsell manage this product?' })).toHaveValue(/Service/);
    await expect(dialog.getByText(/A new product starts as its business classification says/)).toContainText(name);
    await dialog.getByRole('button', { name: 'Pricing' }).click();
    await expect(dialog.getByText('Cost of Goods (KES)', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Selling Price (KES)', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Optional for a service/)).toBeVisible();
    await noHorizontalScroll(page);

    // Delivery can be billed only as a service: the goods in the shop are not offered, the service is.
    await open(page, '/admin/delivery/invoicing', 'Delivery invoicing');
    const item = page.getByRole('combobox', { name: 'Delivery service item' });
    await expect(async () => {
      await item.click();
      await item.fill('E2E Delivery');
      await expect(page.getByRole('option', { name: /E2E Delivery service/ }).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });
    await item.fill('Salt 500g');
    await expect(page.getByRole('option', { name: /Salt 500g/ })).toHaveCount(0, { timeout: 15_000 });
  });
});
