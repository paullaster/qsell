import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { businessDay } from './support/dates';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('money in another currency', () => {
  test('a gift card is issued in dollars at the rate set for the day, and listed with its currency', async ({ page }, testInfo) => {
    const value = testInfo.project.name === 'phone' ? '26' : '25';

    await open(page, '/admin/finance/exchange-rates', 'Exchange rates');
    const rates = page.getByRole('form', { name: 'Set a rate' });
    await pick(page, rates.getByRole('combobox', { name: 'Currency' }), 'US', /USD/);
    await rates.getByLabel('Starts on').fill(businessDay());
    await rates.getByLabel(/for one unit/).fill('129');
    await rates.getByRole('button', { name: 'Save rate' }).click();
    await expect(page.getByText(/^Rate saved: 1 USD = /)).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/pricing/gift-cards', 'Gift cards');
    await page.getByRole('button', { name: 'Issue gift cards' }).click();
    const form = page.getByRole('form', { name: 'Issue gift cards' });
    await noNativeSelect(page);
    await form.getByLabel('Value of each card').fill(value);
    await pick(page, form.getByRole('combobox', { name: 'Currency' }), 'US', /USD/);
    await expect(form.getByText('A card in another currency pays orders in that currency only.')).toBeVisible();
    const reason = form.getByRole('combobox', { name: 'Reason' });
    await reason.click();
    await page.getByRole('option').first().click();
    const complimentary = form.getByRole('radio').last();
    if (await complimentary.isVisible()) await complimentary.check();
    await form.getByRole('button', { name: 'Issue', exact: true }).click();

    const issued = page.getByRole('status', { name: 'Issued cards' });
    await expect(issued).toContainText(`USD ${value}`, { timeout: 30_000 });
    await noHorizontalScroll(page);
    await issued.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(`USD ${value} left of ${value}`).first()).toBeVisible({ timeout: 30_000 });
  });
});
