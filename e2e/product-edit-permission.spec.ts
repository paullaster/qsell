import { expect, test, type Browser, type Page } from '@playwright/test';
import { clerkTool } from './support/clerk-fixture';
import { noHorizontalScroll, open } from './support/page';
import { openNewQuote } from './support/quotes';
import { E2E_URL } from './support/constants';

/** The invoiced order the seed makes for each browser project: one item, "Fish kg Shop". */
const orderNumber = (projectName: string): string => `E2E-CR-${projectName.toUpperCase()}`;

const productWindow = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save Changes' }) });

async function openOrder(page: Page, number: string) {
  await open(page, '/admin/orders', /Customer Orders/);
  await page.getByLabel('Search orders').fill(number);
  // The button of the row that names this order: the list is filtered by the search a moment after it is typed, and the first
  // button on the screen before that belongs to some other order.
  const manage = page.locator('tr, li, article').filter({ hasText: number }).getByRole('button', { name: /Manage/ }).first();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await manage.click();
  const details = page.getByRole('dialog', { name: `Order Details: ${number}` });
  await expect(details).toBeVisible({ timeout: 30_000 });
  return details;
}

/** A person with their own account, signed in through the sign-in form's own endpoint, in a browser of their own. */
async function signedInAs(browser: Browser, email: string, password: string, like: Page): Promise<Page> {
  const context = await browser.newContext({ baseURL: E2E_URL, viewport: like.viewportSize() ?? undefined, storageState: { cookies: [], origins: [] } });
  const csrf = (await (await context.request.get('/api/auth/csrf')).json()) as { csrfToken: string };
  const response = await context.request.post('/api/auth/callback/credentials', { form: { csrfToken: csrf.csrfToken, email, password, callbackUrl: `${E2E_URL}/admin` } });
  expect(response.ok()).toBe(true);
  return await context.newPage();
}

test.describe('the Edit product shortcut on orders and invoices', () => {
  test('a person who may update products gets it on the order and on its invoice preview, and it opens the product', async ({ page }, testInfo) => {
    const number = orderNumber(testInfo.project.name);
    const details = await openOrder(page, number);
    await expect(details.getByRole('link', { name: 'Edit product Fish kg Shop' }).first()).toBeVisible();

    await details.getByRole('button', { name: /Preview/ }).click();
    const preview = page.getByRole('dialog', { name: 'Tax invoice preview' });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    const link = preview.getByRole('link', { name: 'Edit product Fish kg Shop' }).first();
    await expect(link).toBeVisible();

    // One tap, then wait: the product page may still be compiling.
    await link.click();
    await expect(productWindow(page)).toBeVisible({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/admin\/products\/.+quick=1/);
    await expect(preview).toBeAttached();
    await noHorizontalScroll(page);
  });

  test('a person who may not update products is not offered it, on an order, its invoice preview or a quote line', async ({ browser, page }, testInfo) => {
    test.slow();
    const number = orderNumber(testInfo.project.name);
    const clerk = clerkTool(`${testInfo.project.name}${String(Date.now()).slice(-6)}`);
    const theirs = await signedInAs(browser, clerk.email, clerk.password, page);
    try {
      const details = await openOrder(theirs, number);
      // They can read the order and what was sold, but there is no way into the product from it.
      // Each item is drawn twice (cards on a phone, a table from a tablet up), so look at the one that is showing.
      await expect(details.getByText('Fish kg Shop').filter({ visible: true }).first()).toBeVisible();
      await expect(details.getByRole('link', { name: /^Edit product/ })).toHaveCount(0);

      await details.getByRole('button', { name: /Preview/ }).click();
      const preview = theirs.getByRole('dialog', { name: 'Tax invoice preview' });
      await expect(preview).toBeVisible({ timeout: 30_000 });
      await expect(preview.getByText('Fish kg Shop').filter({ visible: true }).first()).toBeVisible();
      await expect(preview.getByRole('link', { name: /^Edit product/ })).toHaveCount(0);
      await noHorizontalScroll(theirs);

      // A quote line: they can still replace the item (that changes their own quote, not the product), but not edit the product.
      const quote = await openNewQuote(theirs);
      await quote.getByRole('combobox', { name: /Quick add to/ }).fill('Flour');
      await theirs.getByRole('option', { name: /Flour 2kg/ }).first().click();
      await quote.getByRole('button', { name: 'Add', exact: true }).first().click();
      await expect(quote.getByRole('spinbutton', { name: 'Quantity of Flour 2kg' })).toBeVisible();
      await expect(quote.getByRole('button', { name: 'Replace Flour 2kg' })).toBeVisible();
      await expect(quote.getByRole('link', { name: /^Edit product/ })).toHaveCount(0);
    } finally {
      await theirs.context().close();
    }
  });
});
