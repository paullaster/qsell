import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Opens an admin page and waits for it to show. The admin shell holds all content back until its
 * session check answers; if that stalls, reload rather than wait out the whole test.
 */
export async function gotoAdmin(page: Page, url: string, heading: string | RegExp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(url);
    try {
      await expect(page.getByRole('heading', { name: heading, level: 1 }).first()).toBeVisible({
        timeout: 30_000,
      });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** The quote editor's dialog. */
export const editor = (page: Page): Locator =>
  page.getByRole('dialog', { name: /Create sales quote|Edit QTE/ });

/** Opens the editor for a new quote, retrying while the page is still hydrating. */
export async function openNewQuote(page: Page): Promise<Locator> {
  await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
  // The editor fetches its data before it draws, so give each press time: pressing again while it loads only starts it over.
  await expect(async () => {
    await page.getByRole('button', { name: /New quote/ }).click();
    await expect(editor(page)).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 100_000, intervals: [1000, 5000] });
  return editor(page);
}

/** Opens the editor on the newest quote of this customer. */
export async function openQuoteOf(page: Page, customerName: string): Promise<Locator> {
  await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
  const row = page.getByRole('row').filter({ hasText: customerName }).first();
  await expect(row).toBeVisible();
  await expect(async () => {
    await row.getByTitle('Edit quote').click();
    await expect(editor(page)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 90_000 });
  return editor(page);
}

/** Types into an autocomplete and chooses the option with this name. */
export async function pick(
  page: Page,
  field: Locator,
  text: string,
  option: string | RegExp,
): Promise<void> {
  // The list is read from the server when the field is typed into; if the first read is slow or lost (a route still
  // compiling on the development server), typing again asks again, as a person would.
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: option }).first().click({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
}

/** Fills the delivery address and saves the quote, then waits for the editor to close. */
export async function saveQuote(page: Page, dialog: Locator, customerName: string): Promise<void> {
  const name = dialog.getByLabel('Customer name');
  if ((await name.inputValue()) === '') await name.fill(customerName);
  const required = dialog.locator('form input:invalid');
  for (let guard = 0; guard < 8 && (await required.count()) > 0; guard += 1) {
    await required.first().fill('Nairobi');
  }
  await dialog.getByRole('button', { name: /Save quote/ }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}
