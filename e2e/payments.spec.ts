import { expect, test, type Page } from '@playwright/test';

/** The payment screens use the shared Autocomplete for every choice, never a native select. */
async function openPayments(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto('/admin/settings/payments');
    try {
      await expect(page.getByRole('heading', { name: 'Payments', level: 2 })).toBeVisible({ timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test.describe('payment settings', () => {
  test('adding a provider and setting it up uses pickers, with no native select', async ({ page }) => {
    await openPayments(page);
    await page.getByRole('button', { name: 'Add a provider' }).click();
    const service = page.getByRole('combobox', { name: 'Payment service' });
    await expect(service).toHaveValue('M-Pesa (Daraja)');
    await service.click();
    await expect(page.getByRole('option', { name: 'Pesapal' })).toBeVisible();
    await service.press('Escape');
    await page.getByRole('button', { name: 'Add provider', exact: true }).click();

    await expect(page.getByRole('combobox', { name: 'Environment' })).toHaveValue('Testing (sandbox)');
    await expect(page.getByRole('combobox', { name: 'Check' })).toHaveValue(/Standard/);
    await expect(page.getByRole('combobox', { name: 'Validation answers' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);

    // Options are fetched only when a picker is opened, and the choice sticks.
    const env = page.getByRole('combobox', { name: 'Environment' });
    await env.click();
    await page.getByRole('option', { name: 'Production' }).click();
    await expect(env).toHaveValue('Production');
  });

  test('the operation picker lists what the provider may run and shows that operation’s fields', async ({ page }) => {
    await openPayments(page);
    const operation = page.getByRole('combobox', { name: 'Operation' }).first();
    await operation.click();
    await expect(page.getByRole('option', { name: /Dynamic QR code/ })).toBeVisible();
    // Money-out operations are off by default, so they are not offered.
    await expect(page.getByRole('option', { name: /Pay a customer \(B2C\)/ })).toBeHidden();
    await operation.fill('QR');
    await page.getByRole('option', { name: /Dynamic QR code/ }).click();
    await expect(page.getByLabel('Name shown')).toBeVisible();
    await page.getByRole('combobox', { name: 'Pay to' }).click();
    await expect(page.getByRole('option', { name: 'A paybill' })).toBeVisible();
  });
});

test.describe('payment activity and Bill Manager', () => {
  test('activity filters by state through a picker', async ({ page }) => {
    await page.goto('/admin/payments/activity');
    await expect(page.getByRole('heading', { name: 'Payment activity', level: 2 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Callbacks received' }).click();
    const filter = page.getByRole('combobox', { name: 'Show only' });
    await filter.click();
    await expect(page.getByRole('option', { name: 'awaiting verification' })).toBeVisible();
    await filter.press('Escape');
    await page.getByRole('button', { name: 'Money received' }).click();
    await page.getByRole('combobox', { name: 'Show only' }).click();
    await expect(page.getByRole('option', { name: 'review' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('Bill Manager says when no paybill exists and has no native select', async ({ page }) => {
    await page.goto('/admin/payments/bills');
    await expect(page.getByRole('heading', { name: 'Bill Manager invoices', level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: 'No M-Pesa paybill' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
  });
});
