import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';

/** Chooses an option of a picker once its list has loaded (the page is drawn before it is wired up, so try until it takes). */
async function choose(page: Page, field: Locator, option: RegExp): Promise<void> {
  await expect(async () => {
    await field.click();
    await page.getByRole('option', { name: option }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('selling document settings', () => {
  test('the admin chooses how a sales invoice behaves: credit check, credit days and hold until paid, with a reason, and it stays as saved', async ({ page }) => {
    test.slow();
    await gotoAdmin(page, '/admin/settings/selling-documents', 'Selling documents');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const card = page.getByRole('listitem').filter({ hasText: 'Sales invoices' }).first();
    await expect(card).toContainText('As built in');
    await expect(card).toContainText('Check the credit limit');
    await expect(card).toContainText('The customer\'s payment terms');
    await expect(card).toContainText('When the document is issued');
    await expect(card).toContainText('Made automatically once approved');
    await card.getByRole('button', { name: /^Change Sales invoices/ }).click();
    const form = page.getByRole('form', { name: /^Change Sales invoices/ });
    await expect(form).toBeVisible();

    // Always hold until paid, no credit days, and a stricter credit check with the days it needs.
    await choose(page, form.getByRole('combobox', { name: 'Stock is released' }), /When payment is received/);
    await choose(page, form.getByRole('combobox', { name: 'Credit days' }), /A fixed number of days/);
    await form.getByLabel('Credit days for every customer').fill('14');
    await choose(page, form.getByRole('combobox', { name: 'Credit check' }), /overdue invoices/);
    await form.getByLabel('An invoice overdue by more than (days)').fill('7');
    // The invoice after approval is automatic to begin with; here it is turned off.
    const automatic = form.getByRole('checkbox', { name: /make its invoice automatically once it is approved/ });
    await expect(automatic).toBeChecked();
    await automatic.uncheck();
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await form.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. It applies to the next document.')).toBeVisible({ timeout: 30_000 });

    const saved = page.getByRole('listitem').filter({ hasText: 'Sales invoices' }).first();
    await expect(saved).toContainText('Changed');
    await expect(saved).toContainText('When payment is received');
    await expect(saved).toContainText('14 days');
    await expect(saved).toContainText('more than 7 days');
    await expect(saved).toContainText('Staff raise it after approval');

    // It is still there after a reload.
    await gotoAdmin(page, '/admin/settings/selling-documents', 'Selling documents');
    await expect(page.getByRole('listitem').filter({ hasText: 'Sales invoices' }).first()).toContainText('When payment is received');

    // A cash sale offers no credit at all.
    const cash = page.getByRole('listitem').filter({ hasText: 'Cash sales' }).filter({ has: page.getByRole('button', { name: /^Change Cash sales/ }) }).first();
    await cash.getByRole('button', { name: /^Change Cash sales/ }).click();
    const cashForm = page.getByRole('form', { name: /^Change Cash sales/ });
    await expect(cashForm.getByRole('combobox', { name: 'Credit check' })).toBeVisible();
    await expect(async () => {
      await cashForm.getByRole('combobox', { name: 'Credit check' }).click();
      await expect(page.getByRole('option')).toHaveCount(1, { timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('option').first()).toContainText('No credit check');
    await page.keyboard.press('Escape');
    await cashForm.getByRole('button', { name: 'Cancel' }).click();

    // Put back to how it was built in (asking first).
    await page.getByRole('listitem').filter({ hasText: 'Sales invoices' }).first().getByRole('button', { name: /^Change Sales invoices/ }).click();
    const reset = page.getByRole('form', { name: /^Change Sales invoices/ });
    await reset.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await reset.getByRole('button', { name: /^Put .* back to how it was built in/ }).click();
    await reset.getByRole('button', { name: /^Confirm: Put / }).click();
    await expect(page.getByText('Put back to how it was built in.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Sales invoices' }).first()).toContainText('As built in');
  });
});
