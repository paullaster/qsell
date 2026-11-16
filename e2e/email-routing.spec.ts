import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin, openNewQuote } from './support/quotes';
import { makeLunchPackage } from './support/storefront-fixtures';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

/** Chooses the first option a picker offers once its list has loaded (the page is drawn before it is wired up, so try until it takes). */
async function pickFirst(page: Page, field: Locator): Promise<void> {
  await expect(async () => {
    await field.click();
    await page.getByRole('option').first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

async function pickKind(page: Page, scope: Locator, list: string, kind: RegExp): Promise<void> {
  const combo = scope.getByRole('combobox', { name: new RegExp(`Add to ${list}`) });
  await expect(async () => {
    await combo.click();
    await page.getByRole('option', { name: kind }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('email routing', () => {
  test('the admin chooses who each business email goes to, copies, blind-copies and answers to, with a reason, and it stays as saved', async ({ page }) => {
    test.slow();
    await gotoAdmin(page, '/admin/settings/email-routing', 'Email routing');
    await expect(page.getByRole('heading', { name: 'Emails', level: 2, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Business emails shown on quotes', level: 2, exact: true })).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const card = page.getByRole('listitem').filter({ hasText: 'Web shop quote request: alert to staff' });
    await expect(card).toContainText('As built in');
    await card.getByRole('button', { name: /^Change Web shop quote request: alert to staff/ }).click();
    const form = page.getByRole('form', { name: /^Change Web shop quote request: alert to staff/ });
    await expect(form).toBeVisible();

    // Sent to: the company email is there by default; add a staff member, found by searching the shared picker.
    const to = form.getByRole('group', { name: 'Sent to' });
    await expect(to).toContainText('The company email');
    await pickKind(page, to, 'Sent to', /A staff member/);
    await pickFirst(page, to.getByRole('combobox', { name: 'Staff member' }));
    await expect(to.getByRole('list', { name: 'Sent to' }).getByRole('listitem')).toHaveCount(2);

    // Copied, blind-copied and replies: another way of finding an address each.
    await pickKind(page, form.getByRole('group', { name: 'Copied (Cc)' }), 'Copied \\(Cc\\)', /The customer/);
    const bcc = form.getByRole('group', { name: 'Blind-copied (Bcc)' });
    await pickKind(page, bcc, 'Blind-copied \\(Bcc\\)', /An address I type/);
    await bcc.getByLabel('Email address').fill('audit@acme-e2e.test');
    await bcc.getByRole('button', { name: 'Add' }).click();
    await expect(bcc).toContainText('audit@acme-e2e.test');
    const replies = form.getByRole('group', { name: /^Replies go to/ });
    await pickKind(page, replies, 'Replies go to \\(Reply-To\\)', /The staff member who sends it/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // A bad address is refused in words; nothing is saved without a reason.
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await form.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. It applies to the next email.')).toBeVisible({ timeout: 30_000 });

    const saved = page.getByRole('listitem').filter({ hasText: 'Web shop quote request: alert to staff' });
    await expect(saved).toContainText('Changed');
    await expect(saved).toContainText('audit@acme-e2e.test');
    await expect(saved).toContainText('The customer');

    // It is still there after a reload, and can be put back to how it was built in (asking first).
    await gotoAdmin(page, '/admin/settings/email-routing', 'Email routing');
    const again = page.getByRole('listitem').filter({ hasText: 'Web shop quote request: alert to staff' });
    await expect(again).toContainText('audit@acme-e2e.test');
    await again.getByRole('button', { name: /^Change Web shop quote request: alert to staff/ }).click();
    const reset = page.getByRole('form', { name: /^Change Web shop quote request: alert to staff/ });
    await reset.getByRole('combobox', { name: /Reason/ }).click();
    await page.getByRole('option').first().click();
    await reset.getByRole('button', { name: /^Put .* back to how it was built in/ }).click();
    await reset.getByRole('button', { name: /^Confirm: Put / }).click();
    await expect(page.getByText('Put back to how it was built in.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Web shop quote request: alert to staff' })).toContainText('As built in');
  });

  test('a quote can have business contacts of its own, chosen on the quote', async ({ page }) => {
    test.slow();
    const editor = await openNewQuote(page);
    const field = editor.getByTestId('quote-contacts');
    await expect(field).toBeVisible({ timeout: 60_000 });
    await expect(field).toContainText('Settings, Email routing');
    await pickKind(page, field, 'the contacts shown on this quote', /The company email/);
    await expect(field.getByRole('list', { name: 'Business contacts shown on this quote' })).toContainText('The company email');
    await field.getByRole('button', { name: /^Use the company.s default contacts/ }).click();
    await expect(field.getByRole('list', { name: 'Business contacts shown on this quote' })).toHaveCount(0);
    await noNativeSelect(page);
  });
});

test.describe('my quote requests', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a signed-in shopper asks for a quote and finds it in their account with where it stands', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
    const shopper = makeShopper(`mq${tag}`, 0);
    const made = makeLunchPackage(`mq${tag}`, 'quote');
    await signInAsShopper(page, shopper);

    // Nothing yet.
    await page.goto('/profile/quotes');
    await expect(page.getByTestId('quotes-empty')).toBeVisible({ timeout: 60_000 });

    await page.goto(`/product/${made.slug}`);
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      await page.getByTestId('package-request-quote').click();
      await expect(page.getByTestId('quote-request-form')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    // A signed-in shopper's details are filled in from their account: no typing needed.
    await expect(page.getByTestId('quote-request-form').getByLabel('Your name')).not.toHaveValue('', { timeout: 30_000 });
    await page.getByTestId('quote-request-form').getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByTestId('quote-requested')).toBeVisible({ timeout: 30_000 });

    await page.goto('/profile');
    await page.getByRole('link', { name: /My quote requests/ }).click();
    const row = page.getByTestId('my-quote-request').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText('Being prepared');
    await expect(row).toContainText('Express lunch');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
