import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { gotoAdmin } from './quotes';

/** Types into a picker and takes the first option the server found (the page is drawn before it is wired up, so try until it takes). */
export async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

/** A new till at the first branch and a shift opened on it with 5,000 in the drawer: the starting point of every counter test. Returns the till's name. */
export async function openShiftOnNewTill(page: Page, testInfo: TestInfo, tag: string): Promise<string> {
  const tillName = `Counter ${tag}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
  await gotoAdmin(page, '/admin/settings/registers', 'Registers');
  await expect(async () => {
    await page.getByRole('button', { name: 'Add a till' }).click();
    await expect(page.getByRole('form', { name: 'Add a till' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  const add = page.getByRole('form', { name: 'Add a till' });
  await add.getByLabel('Name of the till').fill(tillName);
  await expect(async () => {
    await add.getByRole('combobox', { name: /Branch/ }).click();
    await page.getByRole('option').first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
  await add.getByRole('combobox', { name: /Reason/ }).click();
  await page.getByRole('option').first().click();
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Till added.')).toBeVisible({ timeout: 30_000 });
  await gotoAdmin(page, '/admin/shifts', 'Shifts');
  const open = page.getByRole('form', { name: 'Open a shift' });
  await expect(open).toBeVisible({ timeout: 60_000 });
  await pick(page, open.getByRole('combobox', { name: /Till/ }), tillName);
  await open.getByLabel('How many 1000 shilling notes').fill('5');
  await open.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByTestId('shift-notice')).toContainText('Shift opened.', { timeout: 30_000 });
  return tillName;
}

/** Finds a product with the till's one bar and taps its tile once. */
export async function tapProduct(page: Page, name: string): Promise<void> {
  await expect(async () => {
    await page.getByTestId('till-search').fill(name);
    await page.getByTestId('till-tile').filter({ hasText: name }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

/** On a phone the sale is behind a button; on a desktop it is always beside the products. */
export async function openCart(page: Page): Promise<void> {
  const bar = page.getByTestId('till-open-cart');
  if (await bar.isVisible()) await bar.click();
}

/** Closes the sale sheet on a phone (a no-op on a desktop). */
export async function closeCart(page: Page): Promise<void> {
  if (await page.getByRole('dialog', { name: 'The sale' }).isVisible()) await page.keyboard.press('Escape');
}

export const amountOf = (text: string): number => Number(/KES\s*([\d,]+\.\d{2})/.exec(text)?.[1]?.replace(/,/g, '') ?? Number.NaN);

/** Closes the open shift counting exactly what the till should hold, so the next test starts clean. */
export async function closeShiftRight(page: Page): Promise<void> {
  await gotoAdmin(page, '/admin/shifts', 'Shifts');
  const x = page.getByTestId('x-report');
  await expect(x).toContainText('The till should hold', { timeout: 60_000 });
  const shouldHold = amountOf((await x.innerText()).split('The till should hold')[1] ?? '');
  const close = page.getByRole('form', { name: 'Close the shift' });
  await close.getByText('I only have a total').click();
  await close.getByLabel('Total counted (KES)').fill(String(shouldHold));
  await close.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByTestId('shift-notice')).toContainText('Shift closed. Z report', { timeout: 30_000 });
}
