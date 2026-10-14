import { expect, test, type Page, type Request } from '@playwright/test';
import { editor, gotoAdmin, openNewQuote } from './support/quotes';

/** Lookups the page has asked the server for, by list. */
function trackLookups(page: Page, source: string) {
  const bodies: string[] = [];
  page.on('request', (request: Request) => {
    const body = request.postData() ?? '';
    if (request.method() === 'POST' && body.includes(`"${source}"`)) bodies.push(body);
  });
  return bodies;
}

test.describe('the Autocomplete', () => {
  test('loads nothing until it is used, then one page, never the whole list', async ({ page }) => {
    const lookups = trackLookups(page, 'quote-templates');
    const dialog = await openNewQuote(page);
    const field = dialog.getByRole('combobox', { name: 'Start from a template' });

    await page.waitForTimeout(1500);
    expect(lookups).toHaveLength(0);
    await expect(field).toHaveAttribute('aria-expanded', 'false');

    await field.click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(20);
    await expect(page.getByRole('status').filter({ hasText: '20 results' })).toBeVisible();
    expect(lookups).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: 'Load more' })).toBeVisible();
  });

  test('loads more a page at a time', async ({ page }) => {
    const dialog = await openNewQuote(page);
    await dialog.getByRole('combobox', { name: 'Start from a template' }).click();
    await expect(page.getByRole('option')).toHaveCount(20);
    await dialog.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('option')).toHaveCount(40);
    await dialog.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('option')).toHaveCount(47);
    await expect(dialog.getByRole('button', { name: 'Load more' })).toBeHidden();
  });

  test('searches on the server as you type', async ({ page }) => {
    const lookups = trackLookups(page, 'quote-templates');
    const dialog = await openNewQuote(page);
    const field = dialog.getByRole('combobox', { name: 'Start from a template' });
    await field.click();
    await field.fill('Pack 1');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option').first()).toContainText('Pack 10kg');
    expect(lookups.some((body) => body.includes('Pack 1'))).toBe(true);

    await field.fill('zzz nothing');
    await expect(page.getByText('No matches')).toBeVisible();
  });

  test('works by keyboard: arrows move, Enter chooses, Escape closes', async ({ page }) => {
    const dialog = await openNewQuote(page);
    const field = dialog.getByRole('combobox', { name: 'Start from a template' });
    await field.click();
    await field.fill('Pack');
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(field).toHaveAttribute('aria-activedescendant', /option-0$/);
    await field.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /option-1$/);
    await field.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /option-0$/);

    await field.press('Escape');
    await expect(field).toHaveAttribute('aria-expanded', 'false');
    await expect(editor(page)).toBeVisible();

    await field.press('ArrowDown');
    await field.fill('Pack 5');
    await expect(page.getByRole('option')).toHaveCount(1);
    await field.press('Enter');
    await expect(field).toHaveValue('Pack 5kg');
    await expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  test('offers create and view-all as links, and opening one keeps the quote underneath', async ({
    page,
  }) => {
    const dialog = await openNewQuote(page);
    const field = dialog.getByRole('combobox', { name: 'Start from a template' });
    await field.click();
    await expect(dialog.getByRole('link', { name: '+ Create a template' })).toHaveAttribute(
      'href',
      '/admin/quotes/templates/new',
    );
    await dialog.getByLabel('Customer name').fill('Typed before navigating');
    await field.click();
    await dialog.getByRole('link', { name: 'View all templates' }).click();

    await expect(page).toHaveURL(/\/admin\/quotes\/templates$/);
    const modal = page.getByRole('dialog', { name: 'Quote templates' });
    await expect(modal).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await expect(dialog.getByLabel('Customer name')).toHaveValue('Typed before navigating');

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/admin\/quotes$/);
    await expect(modal).toBeHidden();
    await expect(dialog.getByLabel('Customer name')).toHaveValue('Typed before navigating');
  });

  test('the same address on its own is the full page, not a modal', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes/templates', 'Quote templates');
    await expect(page.getByRole('link', { name: /Back to quotes/ })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('has no horizontal scroll', async ({ page }) => {
    const dialog = await openNewQuote(page);
    await dialog.getByRole('combobox', { name: 'Start from a template' }).click();
    await expect(page.getByRole('option').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
