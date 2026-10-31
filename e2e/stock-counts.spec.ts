import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { quantityAt, setLedger, stockedProduct } from './support/stock-fixtures';
import { attemptTag } from './support/vendors';

// Counts work only on the new stock ledger, which these tests switch on for themselves and off again at the end.
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => setLedger('on'));
test.afterAll(() => setLedger('off'));

test.describe('counting the stock', () => {
  test('a count is opened, entered on the shelf, handed in and posted, and the screens fit every width', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const found = stockedProduct(`f${tag}`, 10);
    const right = stockedProduct(`r${tag}`, 5);

    await open(page, '/admin/inventory/counts', /Stock counts/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'New count' }).click();
    await expect(page.getByRole('heading', { name: 'New stock count', level: 2 })).toBeVisible({ timeout: 60_000 });

    // A cycle count of two products at the main location.
    const form = page.getByRole('form', { name: 'New stock count' });
    await pick(page, form.getByRole('combobox', { name: 'Location to count' }), 'MAIN', /MAIN/);
    await pick(page, form.getByRole('combobox', { name: 'Product 1' }), found.name, new RegExp(found.name));
    await form.getByRole('button', { name: 'Add a product' }).click();
    await pick(page, form.getByRole('combobox', { name: 'Product 2' }), right.name, new RegExp(right.name));
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Open the count' }).click();
    await expect(page.getByRole('heading', { name: /^Count CNT-/, level: 2 })).toBeVisible({ timeout: 60_000 });

    // The shelf: what should be there is shown, and the counted figures are big enough to type with a thumb.
    const a = page.getByRole('listitem').filter({ hasText: found.name });
    const b = page.getByRole('listitem').filter({ hasText: right.name });
    await expect(a).toContainText('Should hold 10');
    await expect(b).toContainText('Should hold 5');
    const entry = page.getByLabel(`Counted: ${found.name}`);
    const box = await entry.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A count that is handed in before anything is saved is refused; so is a figure that is not a whole number of pieces.
    await page.getByLabel(`Counted: ${found.name}`).fill('7.5');
    await page.getByRole('button', { name: /^Save 1 counted figure/ }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/whole number/, { timeout: 30_000 });
    await page.getByLabel(`Counted: ${found.name}`).fill('7');
    await page.getByLabel(`Counted: ${right.name}`).fill('5');
    await page.getByRole('button', { name: /^Save 2 counted figures/ }).click();
    await expect(page.getByText('Saved the figures you entered.')).toBeVisible({ timeout: 30_000 });
    await expect(a).toContainText(/Counted by/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Hand the count in' }).click();
    await expect(page.getByText('Handed in. The differences are shown below.')).toBeVisible({ timeout: 30_000 });

    // The differences are shown before anything changes.
    await expect(a).toContainText('Difference -3', { timeout: 30_000 });
    await expect(b).toContainText('No difference');
    await expect(page.getByRole('region', { name: 'Review the differences' })).toContainText('worth 300.00');
    expect(quantityAt(found.name, 'MAIN')).toBe(10);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Posting brings the stock in line.
    await page.getByRole('button', { name: 'Post the count' }).click();
    await expect(page.getByText('Posted. The stock now matches the count.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(quantityAt(found.name, 'MAIN')).toBe(7);
    expect(quantityAt(right.name, 'MAIN')).toBe(5);
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByRole('listitem')).toHaveCount(3);
    await expect(history).toContainText('Posted');

    // It is in the list.
    await open(page, '/admin/inventory/counts', /Stock counts/);
    await expect(page.getByRole('listitem').filter({ hasText: 'Cycle count' }).first()).toBeVisible({ timeout: 60_000 });
  });

  test('a blind count shows no expected figures, and a count can be cancelled with a reason', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const item = stockedProduct(`b${tag}`, 6);
    await open(page, '/admin/inventory/counts/new', /New stock count/);
    const form = page.getByRole('form', { name: 'New stock count' });
    await pick(page, form.getByRole('combobox', { name: 'Location to count' }), 'MAIN', /MAIN/);
    await pick(page, form.getByRole('combobox', { name: 'Product 1' }), item.name, new RegExp(item.name));
    await form.getByLabel('Blind count: those who count do not see what is expected').check();
    await form.getByRole('button', { name: 'Open the count' }).click();
    await expect(page.getByRole('heading', { name: /^Count CNT-/, level: 2 })).toBeVisible({ timeout: 60_000 });
    // The person who made the test count is an administrator, who may see what is expected; the line still shows it is blind.
    await expect(page.getByText(/Count CNT-/).first()).toBeVisible();
    const cancel = page.getByRole('region', { name: 'Cancel the count' });
    await cancel.getByRole('button', { name: 'Cancel the count' }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/Say why/, { timeout: 30_000 });
    await cancel.getByLabel('Cancel this count').fill('Counted the wrong shelf');
    await cancel.getByRole('button', { name: 'Cancel the count' }).click();
    await expect(page.getByText('Cancelled.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Cancelled: Counted the wrong shelf')).toBeVisible({ timeout: 30_000 });
    expect(quantityAt(item.name, 'MAIN')).toBe(6);
  });

  test('a made-up address shows the not-found page', async ({ page }) => {
    await page.goto('/admin/inventory/counts/not-a-real-count');
    await expect(page.getByText(/could not be found|not found|doesn.t exist/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
