import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('new customer from a picker', () => {
  test('the picker links to the form, it opens over the screen, and the new customer is chosen on return', async ({ page }, testInfo) => {
    const stamp = `${testInfo.project.name}${String(Date.now()).slice(-7)}`;
    const name = `E2E Walk-in ${stamp}`;
    await open(page, '/admin/finance/receipts/new', 'New receipt');
    await noNativeSelect(page);
    const customer = page.getByRole('combobox', { name: 'Customer' });
    await clickUntilVisible(customer, page.getByRole('link', { name: '+ Create a customer' }));
    await expect(page.getByRole('link', { name: '+ Create a customer' })).toHaveAttribute('href', '/admin/customers/new');
    await page.getByRole('link', { name: '+ Create a customer' }).click();

    await expect(page).toHaveURL(/\/admin\/customers\/new$/);
    const dialog = page.getByRole('dialog', { name: 'Create customer' });
    await expect(dialog).toBeVisible();
    // The receipt is still there underneath.
    await expect(page.getByRole('heading', { name: 'New receipt', level: 2 })).toBeVisible();
    await expect(dialog.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);

    // The server's rules answer in words, and nothing is lost.
    await dialog.getByLabel('Customer name').fill(name);
    await dialog.getByLabel('Email').fill('not-an-email');
    await dialog.getByRole('button', { name: 'Create customer' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/email/i);
    await dialog.getByLabel('Email').fill(`walkin-${stamp.toLowerCase()}@example.test`);
    await dialog.getByLabel('Buyer KRA PIN').fill('12345');
    await dialog.getByRole('button', { name: 'Create customer' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/KRA PIN/);
    await dialog.getByLabel('Buyer KRA PIN').fill('a123456789z');

    // Credit terms appear only for a credit customer.
    await expect(dialog.getByLabel('Credit limit')).toHaveCount(0);
    await pick(page, dialog.getByRole('combobox', { name: 'Account type' }), 'Credit', /Credit \(pays later\)/);
    await expect(dialog.getByLabel('Credit limit')).toBeVisible();
    await dialog.getByLabel('Credit limit').fill('1500');
    await dialog.getByLabel('Payment terms (days)').fill('30');
    await dialog.getByRole('button', { name: 'Create customer' }).click();

    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/admin\/finance\/receipts\/new$/);
    await expect(page.getByRole('combobox', { name: 'Customer' })).toHaveValue(name);

    // Making the same email again is refused with words.
    await page.goto('/admin/customers/new');
    const form = page.getByRole('form', { name: 'New customer' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(async () => {
      await form.getByLabel('Customer name').fill(`${name} again`);
      await form.getByLabel('Email').fill(`WALKIN-${stamp.toLowerCase()}@example.test`);
      await form.getByRole('button', { name: 'Create customer' }).click();
      await expect(form.getByRole('alert')).toContainText(/already exists/, { timeout: 5000 });
    }).toPass({ timeout: 60_000 });
  });
});
