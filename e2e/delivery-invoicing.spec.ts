import { expect, test, type Locator } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';

/** Brings a button to the middle of the screen first; on a phone the development badge covers the bottom corner. */
async function press(button: Locator): Promise<void> {
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await button.click();
}

test.describe('delivery invoicing', () => {
  test('delivery on the same invoice or on its own is shown with an example, chosen with an item and a reason, and kept', async ({ page }) => {
    test.slow();
    // The item that stands for delivery has to be a service, so one is made first (the screens for that are checked in service-classification).
    deliveryTool('service', 'ensure');
    await open(page, '/admin/delivery/invoicing', 'Delivery invoicing');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // The default is one invoice: delivery a line, and the tax for the products, for the delivery and in all.
    const preview = page.getByRole('group', { name: 'How it looks' });
    await expect(page.getByRole('radio', { name: /On the same invoice/ })).toBeChecked();
    await expect(preview.getByRole('figure', { name: 'The invoice' })).toContainText('Delivery');
    await expect(preview).toContainText('VAT on products');
    await expect(preview).toContainText('VAT on delivery (16%)');
    await expect(preview).toContainText('Total VAT');
    await expect(preview.getByRole('figure', { name: 'Invoice for the delivery service' })).toHaveCount(0);
    await expect(page.getByText('No item chosen')).toBeVisible();

    // On its own: two invoices that add up to the same order.
    await page.getByRole('radio', { name: /On its own invoice/ }).check();
    await expect(preview.getByRole('figure', { name: 'Invoice for the products' })).toContainText('1,160.00');
    await expect(preview.getByRole('figure', { name: 'Invoice for the delivery service' })).toContainText('348.00');
    await noInnerHorizontalScroll(page);
    await noHorizontalScroll(page);

    // Saving needs a reason, and the item the delivery is signed as.
    const form = page.getByRole('form', { name: 'Save delivery invoicing' });
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await form.getByLabel('Why? (kept with the change)').fill('Our accountant wants delivery apart');
    await pick(page, page.getByRole('combobox', { name: 'Delivery service item' }), 'E2E Delivery', /E2E Delivery service/);
    await expect(page.getByText('Save to check this item')).toBeVisible();
    await press(form.getByRole('button', { name: 'Save' }));
    await expect(page.getByText('Saved. New invoices follow this choice')).toBeVisible({ timeout: 30_000 });
    // Once saved, the item is checked: whether KRA knows it and what tax it carries.
    await expect(page.getByLabel('About this item')).toContainText('Not registered with KRA yet');

    // The item can be opened in its edit window from here (it is registered or taxed there), and closing it comes back to this screen.
    const itemLink = page.getByRole('link', { name: /^Edit product E2E Delivery service/ });
    await expect(itemLink).toBeVisible();
    await itemLink.click();
    const productWindow = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save Changes' }) });
    await expect(productWindow).toBeVisible({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/admin\/products\/.+quick=1/);
    await page.keyboard.press('Escape');
    await expect(productWindow).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/admin\/delivery\/invoicing/);
    await expect(page.getByRole('form', { name: 'Save delivery invoicing' })).toBeVisible();

    // It is kept.
    await page.reload();
    await expect(page.getByRole('radio', { name: /On its own invoice/ })).toBeChecked({ timeout: 30_000 });
    await expect(page.getByRole('combobox', { name: 'Delivery service item' })).toHaveValue(/E2E Delivery service/);

    // Put back (the mode and the item), so the shop's other tests invoice as they always did.
    await page.getByRole('radio', { name: /On the same invoice/ }).check();
    await page.getByRole('button', { name: 'Clear Delivery service item' }).click();
    await page.getByLabel('Why? (kept with the change)').fill('Back to one invoice after the test');
    await press(page.getByRole('form', { name: 'Save delivery invoicing' }).getByRole('button', { name: 'Save' }));
    await expect(page.getByText('Saved. New invoices follow this choice')).toBeVisible({ timeout: 30_000 });
  });
});
