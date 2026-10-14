import { expect, test } from '@playwright/test';
import { gotoAdmin } from './support/quotes';

test.describe('the quotes list', () => {
  test('shows one page, and loads more on request', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    const rows = page.getByRole('table').first().locator('tbody tr');
    await expect(rows).toHaveCount(25);
    await expect(
      page.getByRole('status').filter({ hasText: '25 quotes shown, more available' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows.nth(26)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(32);
  });

  test('searching goes to the server and is kept in the address', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await page.getByRole('searchbox', { name: 'Search quotes' }).fill('List customer 07');
    await expect(page).toHaveURL(/q=List\+customer\+07|q=List%20customer%2007/);
    await expect(page.getByRole('table').first().locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('cell', { name: /List customer 07/ })).toBeVisible();
  });

  test('a filtered address works on its own, and a bad one falls back to the plain list', async ({
    page,
  }) => {
    await gotoAdmin(page, '/admin/quotes?status=cancelled', 'Sales Quotes');
    const rows = page.getByRole('table').first().locator('tbody tr');
    await expect(rows.first()).toContainText('cancelled');
    for (const row of await rows.all()) await expect(row).toContainText('cancelled');
    await expect(page.getByRole('combobox', { name: 'Filter quotes by status' })).toHaveValue(
      'cancelled',
    );

    await gotoAdmin(page, `/admin/quotes?status=not-a-status&q=${'x'.repeat(300)}`, 'Sales Quotes');
    await expect(page.getByRole('table').first().locator('tbody tr')).toHaveCount(25);
  });

  test('says so when nothing matches', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes?q=zzz-no-such-quote', 'Sales Quotes');
    await expect(page.getByText('No quotes match those filters.')).toBeVisible();
  });

  test('the list is on screen before the editor’s data is fetched', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') bodies.push(request.postData() ?? '');
    });
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await expect(page.getByRole('table').first().locator('tbody tr').first()).toBeVisible();
    // Nothing the editor needs (the catalogue) has been asked for yet.
    expect(bodies.some((body) => body.includes('"limit"') && body.includes('products'))).toBe(
      false,
    );
    await expect(async () => {
      await page.getByRole('button', { name: /New quote/ }).click();
      await expect(page.getByRole('dialog', { name: /Create sales quote/ })).toBeVisible({
        timeout: 4000,
      });
    }).toPass({ timeout: 60_000 });
  });
});

test.describe('the template lists', () => {
  test('the templates tab pages, searches and opens a template’s editor', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await expect(async () => {
      await page.getByRole('tab', { name: 'Templates', exact: true }).click();
      await expect(page.getByRole('searchbox', { name: 'Search templates' })).toBeVisible({
        timeout: 4000,
      });
    }).toPass({ timeout: 90_000 });
    const rows = page.getByRole('table').locator('tbody tr');
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(47);

    await page.getByRole('searchbox', { name: 'Search templates' }).fill('Pack 10');
    await expect(rows).toHaveCount(1);
    await page.getByRole('button', { name: 'Pack 10kg', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Quote template editor' });
    await expect(editor).toBeVisible();
    // The editor's pickers are searchable lists, not preloaded selects.
    await expect(editor.getByRole('combobox', { name: 'Default customer' })).toBeVisible();
    await expect(editor.getByRole('combobox', { name: 'Currency' })).toHaveValue('KES');
    await expect(editor.getByRole('combobox', { name: 'Payment method' })).toHaveValue('M-Pesa');
    await expect(editor.getByRole('radio', { name: 'Catalog' }).first()).toBeChecked();
  });

  test('the section templates route pages and filters by status', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes/section-templates', 'Section templates');
    await expect(page.getByText('Baking set').filter({ visible: true }).first()).toBeVisible();
    const filter = page.getByRole('combobox', { name: 'Filter section templates by status' });
    await filter.click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await page.getByRole('option', { name: 'Archived' }).click();
    await expect(page.getByText('No section templates match those filters.')).toBeVisible();
  });
});
