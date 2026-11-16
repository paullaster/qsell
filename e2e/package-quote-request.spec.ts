import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeLunchPackage } from './support/storefront-fixtures';

/** Sets how shoppers order the package, from the admin console (Pricing, Packages), with a reason as every change needs. */
async function setMode(page: Page, packageName: string, mode: RegExp): Promise<void> {
  await open(page, '/admin/pricing/packages', 'Packages');
  const card = page.getByRole('listitem').filter({ hasText: packageName }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole('button', { name: `Change ${packageName}` }).click();
  const change = page.getByRole('form', { name: 'Change package' });
  await expect(change).toBeVisible();
  await change.getByRole('combobox', { name: /How shoppers order it/ }).click();
  await page.getByRole('option', { name: mode }).click();
  await noNativeSelect(page);
  await change.getByRole('combobox', { name: /Reason/ }).click();
  await page.getByRole('option').first().click();
  await change.getByRole('button', { name: 'Save package' }).click();
  await expect(page.getByText('Package saved. It applies to the next order.')).toBeVisible({ timeout: 30_000 });
}

async function openProduct(page: Page, slug: string, name: string): Promise<void> {
  await page.goto(`/product/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
}

test.describe('a package sold by quote request', () => {
  test('the admin chooses per package whether the shop offers Add to cart, Request a quote or both, and a request reaches the quotes', async ({ page }, testInfo) => {
    test.slow();
    const tag = `pq${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
    const made = makeLunchPackage(tag);

    // To begin with it is the cart, as before: no quote button, and the group order is offered.
    await openProduct(page, made.slug, made.name);
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeVisible();
    await expect(page.getByTestId('package-request-quote')).toHaveCount(0);

    // Either: both buttons.
    await setMode(page, made.name, /^Either/);
    await openProduct(page, made.slug, made.name);
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeVisible();
    await expect(page.getByTestId('package-request-quote')).toBeVisible();

    // Quote only: no cart, no Buy now, no group order, no order again.
    await setMode(page, made.name, /^Request a quote only/);
    await openProduct(page, made.slug, made.name);
    await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Buy now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Order for a group' })).toHaveCount(0);
    await expect(page.getByTestId('package-request-quote')).toBeEnabled();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Asking: the form wants a name and a way to answer, and the server says so when they are missing.
    await expect(async () => {
      await page.getByTestId('package-request-quote').click();
      await expect(page.getByTestId('quote-request-form')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    const form = page.getByTestId('quote-request-form');
    await noHorizontalScroll(page);
    await form.getByLabel('Your name').fill(`Wanjiru ${tag}`);
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(form.getByRole('alert')).toContainText('email address or a phone number');
    await form.getByLabel('Email').fill(`${tag}@request.test`);
    await form.getByLabel('Anything we should know (optional)').fill('Office party of twelve');
    await form.getByRole('button', { name: 'Send request' }).click();
    const done = page.getByTestId('quote-requested');
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toContainText('We have your request: quote');

    // Staff find it in Quotes, marked as coming from the shop.
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    await expect(page.getByText(`Wanjiru ${tag}`).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Requested on the web shop').filter({ visible: true }).first()).toBeVisible();
  });
});
