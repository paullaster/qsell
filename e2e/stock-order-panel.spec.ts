import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { makePlace, placeOrder, quantityAt, receiveStock, setLedger, stockedProduct } from './support/stock-fixtures';
import { attemptTag } from './support/vendors';

// These work only on the new stock ledger, which the tests switch on for themselves and off again at the end.
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => setLedger('on'));
test.afterAll(() => setLedger('off'));

async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(orderNumber);
  const manage = page.getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await manage.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
}

test.describe('where an order’s stock is held', () => {
  test('is shown on the order, and can be taken from another place with a reason', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const otherCode = `E2EOP${tag}`.slice(0, 20).toUpperCase();
    const product = stockedProduct(`o${tag}`, 10);
    makePlace(otherCode, `Order place ${tag}`);
    receiveStock(product.id, 10, otherCode);
    const orderNumber = placeOrder(tag, product.id, 3);
    expect(quantityAt(product.name, 'MAIN')).toBe(10);

    await openOrder(page, orderNumber);
    const panel = page.getByRole('region', { name: 'Order stock' });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toContainText(product.name);
    const line = panel.locator(`li[data-product="${product.id}"]`);
    await expect(line).toContainText('Held 3 at MAIN', { timeout: 30_000 });
    await expect(line).toContainText('The whole order could come from here');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Moving it needs a reason and a place that can cover it.
    await line.getByRole('button', { name: `Take ${product.name} from another place` }).click();
    await pick(page, line.getByRole('combobox', { name: `Take ${product.name} from` }), otherCode, new RegExp(otherCode));
    await line.getByRole('button', { name: 'Move the stock' }).click();
    await expect(panel.locator('p[role="alert"]').first()).toContainText(/Say why/, { timeout: 30_000 });
    await line.getByLabel('Why').fill('The customer collects from there');
    await line.getByRole('button', { name: 'Move the stock' }).click();
    await expect(panel.getByText(new RegExp(`The stock for ${product.name} is now held at`))).toBeVisible({ timeout: 30_000 });

    // The history of the line shows both holds.
    await expect(line.locator('li[data-state="released"]')).toContainText('Given back 3 at MAIN', { timeout: 30_000 });
    await expect(line.locator('li[data-state="released"]')).toContainText('re-sourced: The customer collects from there');
    await expect(line.locator('li[data-state="held"]')).toContainText(`Held 3 at ${otherCode}`);
    await expect(line.locator('li[data-state="held"]')).toContainText('Moved here by a person, from MAIN: The customer collects from there');
    // Nothing physical moved; only the promise did.
    expect(quantityAt(product.name, 'MAIN')).toBe(10);
    expect(quantityAt(product.name, otherCode)).toBe(10);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});

test.describe('stock by location', () => {
  test('shows what each place holds and what is promised, narrowed by a search or a place, and fits every width', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const otherCode = `E2EMX${tag}`.slice(0, 20).toUpperCase();
    const product = stockedProduct(`m${tag}`, 8);
    makePlace(otherCode, `Matrix place ${tag}`);
    receiveStock(product.id, 5, otherCode);
    placeOrder(`m${tag}`, product.id, 2);

    await open(page, '/admin/inventory/by-location', /Stock by location/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByLabel('Search products').fill(product.name);
    const wide = page.locator('table[aria-label="Stock by location"]');
    const cards = page.locator('ul[aria-label="Stock by location"]');
    const row = (await wide.isVisible()) ? wide.locator(`tr[data-product="${product.id}"]`) : cards.locator(`li[data-product="${product.id}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    // The place codes head the columns of the table; on a phone each card names its places.
    if (await wide.isVisible()) await expect(wide.locator('thead')).toContainText('MAIN');
    else await expect(row).toContainText('MAIN');
    await expect(row).toContainText('2 promised');
    await expect(row).toContainText('13');

    // Looking at one place shows that place's figure, and the total still counts every place.
    await pick(page, page.getByRole('combobox', { name: 'Only this location' }), otherCode, new RegExp(otherCode));
    const only = (await wide.isVisible()) ? wide.locator(`tr[data-product="${product.id}"]`) : cards.locator(`li[data-product="${product.id}"]`);
    await expect(only).toContainText('13', { timeout: 30_000 });
    await expect(only).toContainText('5');
    await page.getByLabel('Only products with stock').check();
    await expect(only).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search products').fill('zzzz-no-such-product-here');
    await expect(page.getByText('No product matches that.')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
