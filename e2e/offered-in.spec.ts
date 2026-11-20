import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeLimitedProduct } from './support/storefront-fixtures';

/** The product window (the dialog the products screen opens). */
const productWindow = (page: Page): Locator => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save Changes' }) });

/** Types the product's name into the picker and waits for the server's answer; the page is drawn before it is wired up, so try until the list answers. */
async function search(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill('');
    await field.fill(text);
    await expect(page.getByRole('listbox')).toHaveAttribute('aria-busy', 'false', { timeout: 4000 });
    // Give the typed text's search time to come back (it is sent after a short pause).
    await page.waitForTimeout(1200);
    await expect(page.getByRole('listbox')).toHaveAttribute('aria-busy', 'false', { timeout: 4000 });
  }).toPass({ timeout: 120_000 });
}

/** Changes the product's Offered in list from its edit window and checks it was kept by reading it back. */
async function setOffered(page: Page, id: string, on: boolean): Promise<void> {
  await page.goto(`/admin/products/${id}`);
  await expect(productWindow(page)).toBeVisible({ timeout: 60_000 });
  await productWindow(page).getByRole('button', { name: 'Media' }).click();
  const box = productWindow(page).getByTestId('offered-in').getByLabel('Sales orders');
  await expect(box).toBeVisible({ timeout: 30_000 });
  if (on) await box.check();
  else await box.uncheck();
  await productWindow(page).getByRole('button', { name: 'Save Changes' }).click();
  // The window is closed by the save finishing (while it saves, its button reads Saving, so wait for the dialog itself to go).
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
  // The saved list is what the window shows when it is opened again (the page is drawn before it is wired up, so click the tab until it takes).
  await page.goto(`/admin/products/${id}`);
  await expect(productWindow(page)).toBeVisible({ timeout: 60_000 });
  const again = productWindow(page).getByTestId('offered-in').getByLabel('Sales orders');
  await expect(async () => {
    await productWindow(page).getByRole('button', { name: 'Media' }).click();
    await expect(again).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
  if (on) await expect(again).toBeChecked({ timeout: 10_000 });
  else await expect(again).not.toBeChecked({ timeout: 10_000 });
}

test.describe('where a product is offered', () => {
  test('a product switched off for sales orders is not found when a sales order is taken, and comes back when it is switched on again', async ({ page }, testInfo) => {
    test.slow();
    const tag = `of${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLimitedProduct(tag, 1, 100);
    const openForm = async () => {
      await gotoAdmin(page, '/admin/sales-orders', 'Sales orders');
      await expect(async () => {
        await page.getByRole('button', { name: 'New sales order' }).click();
        await expect(page.getByRole('form', { name: 'New sales order' })).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 150_000 });
      return page.getByRole('combobox', { name: 'Add a product' });
    };

    // Offered everywhere to begin with: a sales order finds it.
    const first = await openForm();
    await search(page, first, made.name);
    await expect(page.getByRole('option', { name: new RegExp(made.name) }).first()).toBeVisible({ timeout: 30_000 });

    // Switched off for sales orders on the product: the sales order's list answers, and has no such product.
    await setOffered(page, made.id, false);
    const second = await openForm();
    await search(page, second, made.name);
    await expect(page.getByText('No matches').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('option', { name: new RegExp(made.name) })).toHaveCount(0);
    await noHorizontalScroll(page);

    // And back on: it is found again.
    await setOffered(page, made.id, true);
    const third = await openForm();
    await search(page, third, made.name);
    await expect(page.getByRole('option', { name: new RegExp(made.name) }).first()).toBeVisible({ timeout: 30_000 });
  });
});
