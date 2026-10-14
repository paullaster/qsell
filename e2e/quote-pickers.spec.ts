import { expect, test } from '@playwright/test';
import { gotoAdmin, openNewQuote, pick } from './support/quotes';

test.describe('the customer, currency and payment method pickers', () => {
  test('choosing a customer fills the form; a credit customer is put on account', async ({
    page,
  }) => {
    const dialog = await openNewQuote(page);
    const customer = dialog.getByRole('combobox', { name: 'Trade customer' });
    const method = dialog.getByRole('combobox', { name: 'Payment method' });

    await pick(page, customer, 'Alice', /Alice Cash/);
    await expect(dialog.getByLabel('Customer name')).toHaveValue('Alice Cash');
    await expect(dialog.getByLabel('Email')).toHaveValue('alice.cash@e2e.test');
    await expect(method).toHaveValue('M-Pesa');

    await pick(page, customer, 'Bob', /Bob Credit/);
    await expect(dialog.getByLabel('Customer name')).toHaveValue('Bob Credit');
    await expect(method).toHaveValue('On account');

    // Clearing the customer takes the quote off account again.
    await dialog.getByRole('button', { name: 'Clear Trade customer' }).click();
    await expect(method).toHaveValue('M-Pesa');
  });

  test('the customer list is searched on the server and is paged, not preloaded', async ({
    page,
  }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData() ?? '';
      if (request.method() === 'POST' && body.includes('"trade-customers"')) bodies.push(body);
    });
    const dialog = await openNewQuote(page);
    await page.waitForTimeout(1000);
    expect(bodies).toHaveLength(0);
    const customer = dialog.getByRole('combobox', { name: 'Trade customer' });
    await customer.click();
    await expect(page.getByRole('option')).toHaveCount(20);
    await customer.fill('Bulk customer 2');
    await expect(page.getByRole('option').first()).toContainText('Bulk customer 2');
    expect(bodies.some((body) => body.includes('Bulk customer 2'))).toBe(true);
  });

  test('on account is offered only for a credit customer', async ({ page }) => {
    const dialog = await openNewQuote(page);
    const method = dialog.getByRole('combobox', { name: 'Payment method' });
    await method.click();
    await expect(page.getByRole('option', { name: 'On account' })).toHaveCount(0);
    await expect(page.getByRole('option')).toHaveCount(4);
    await method.press('Escape');

    await pick(page, dialog.getByRole('combobox', { name: 'Trade customer' }), 'Bob', /Bob Credit/);
    // The credit customer is already on account, and the list now offers it.
    await expect(method).toHaveValue('On account');
    await method.click();
    await expect(page.getByRole('option', { name: 'On account' })).toBeVisible();
  });

  test('currency offers only enabled currencies', async ({ page }) => {
    const dialog = await openNewQuote(page);
    const currency = dialog.getByRole('combobox', { name: 'Currency' });
    await currency.click();
    await expect(page.getByRole('option')).toHaveCount(2);
    await page.getByRole('option', { name: /USD/ }).click();
    await expect(currency).toHaveValue('USD');
  });

  test('the quotes list can be filtered by status', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    const filter = page.getByRole('combobox', { name: 'Filter quotes by status' });
    await expect(async () => {
      await filter.click();
      await expect(page.getByRole('option').first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('option')).toHaveCount(10);
    await filter.fill('pending');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: 'pending approval' }).click();
    await expect(filter).toHaveValue('pending approval');
  });
});

test.describe('the admin shell', () => {
  test('shows the page at once, even when every server action is slow', async ({ page }) => {
    // Hold every server-action request back for a long while: the shell and the page must not
    // wait on any of them (no "Preparing admin session…" screen).
    await page.route('**/*', async (route) => {
      if (route.request().method() === 'POST')
        await new Promise((done) => setTimeout(done, 20_000));
      await route.continue();
    });
    await page.goto('/admin/quotes');
    await expect(page.getByText('Preparing admin session')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sales Quotes', level: 1 }).first()).toBeVisible(
      {
        timeout: 8000,
      },
    );
    await expect(page.getByRole('button', { name: /New quote/ })).toBeVisible({ timeout: 8000 });
  });
});
