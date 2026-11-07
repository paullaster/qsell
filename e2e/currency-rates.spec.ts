import { expect, test } from '@playwright/test';
import { businessDay } from './support/dates';
import { pick } from './support/quotes';
import { open } from './support/page';

test.describe('the shop rate and the books rate', () => {
  test('a rate set in Finance is the one the currencies screen shows, and it cannot be typed over there', async ({ page }, testInfo) => {
    test.slow();
    const rate = testInfo.project.name === 'phone' ? '151.5' : '150';
    const franc = page.getByRole('row').filter({ hasText: 'Swiss Franc' });

    // The shop has the currency, and no books rate decides it yet.
    await page.goto('/admin/currencies');
    await expect(page.getByRole('heading', { name: 'Multi-Market Currency Management' })).toBeVisible({ timeout: 60_000 });
    await expect(franc).toBeVisible({ timeout: 30_000 });

    // The rate is set where the books keep it.
    await open(page, '/admin/finance/exchange-rates', 'Exchange rates');
    const form = page.getByRole('form', { name: 'Set a rate' });
    await pick(page, form.getByRole('combobox', { name: 'Currency' }), 'CH', /CHF/);
    await form.getByLabel('Starts on').fill(businessDay());
    await form.getByLabel(/for one unit/).fill(rate);
    await form.getByRole('button', { name: 'Save rate' }).click();
    await expect(page.getByText(/^Rate saved: 1 CHF = /)).toBeVisible({ timeout: 30_000 });

    // The shop follows it, at once, and says where it comes from.
    await page.goto('/admin/currencies');
    await expect(franc).toBeVisible({ timeout: 60_000 });
    await expect(franc).toContainText(`1 CHF = ${rate} KES since ${businessDay()}`, { timeout: 30_000 });
    await expect(franc.getByRole('link', { name: 'The rate of CHF comes from Finance, exchange rates' })).toHaveAttribute('href', '/admin/finance/exchange-rates');
    await expect(franc).not.toContainText('Typed here');

    // Its edit window offers no rate to type: it says to change it in Finance.
    await franc.getByTitle('Edit currency').click();
    const note = page.getByRole('note', { name: 'Where this rate comes from' });
    await expect(note).toContainText(`1 CHF = ${rate} KES`);
    await expect(note.getByRole('link', { name: 'Finance, exchange rates' })).toBeVisible();
    await expect(page.getByPlaceholder('130.00')).toHaveCount(0);
  });
});
