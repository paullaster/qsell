import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';

test.describe('van sales settings', () => {
  test('both modes start off; a company switches them on with a reason, the rules are saved and kept, and a bad value is refused in words', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const limit = phone ? '750' : '1500';

    await gotoAdmin(page, '/admin/settings/sales/van-sales', 'Van sales');
    const form = page.getByRole('form', { name: 'Van sales' });
    await expect(form).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const vanSell = form.getByRole('checkbox', { name: /^Van sell/ });
    const preSell = form.getByRole('checkbox', { name: /^Pre-sell/ });
    const save = form.getByRole('button', { name: 'Save' });

    // Nothing to save until something changes, and nothing is on by default (the other project may have switched them on already).
    await expect(save).toBeDisabled();
    await expect(async () => {
      if (!(await vanSell.isChecked())) await vanSell.check();
      if (!(await preSell.isChecked())) await preSell.check();
      await expect(vanSell).toBeChecked({ timeout: 3000 });
      await expect(preSell).toBeChecked({ timeout: 3000 });
    }).toPass({ timeout: 120_000 });

    // The rules: what happens to missing stock, and a limit for a second person.
    await form.getByRole('radio', { name: /Write it off as a stock loss/ }).check();
    await form.getByLabel(/second person must decide a shortage/).fill(limit);

    // A bad value is said in words, and cannot be saved.
    await form.getByRole('radio', { name: /The rep must be near the customer/ }).check();
    const near = form.getByLabel(/How near counts as at the customer/);
    await expect(near).toBeVisible();
    await near.fill('5');
    await expect(form.getByRole('alert')).toContainText('whole metres from 20 to 5000');
    await expect(save).toBeDisabled();
    await near.fill('150');
    await expect(form.getByRole('alert')).toHaveCount(0);

    // A reason is needed.
    await expect(save).toBeDisabled();
    await expect(async () => {
      await form.getByRole('combobox', { name: /Reason/ }).click();
      await page.getByRole('option').first().click({ timeout: 4000 });
      await expect(save).toBeEnabled({ timeout: 3000 });
    }).toPass({ timeout: 120_000 });
    await save.click();
    await expect(page.getByText('Saved. Van sales now follows these rules.')).toBeVisible({ timeout: 30_000 });
    await expect(form.getByText('Van sell on')).toBeVisible();
    await expect(form.getByText('Pre-sell on')).toBeVisible();
    await expect(save).toBeDisabled();

    // Kept: a fresh load shows what was saved.
    await gotoAdmin(page, '/admin/settings/sales/van-sales', 'Van sales');
    const again = page.getByRole('form', { name: 'Van sales' });
    await expect(again.getByRole('radio', { name: /Write it off as a stock loss/ })).toBeChecked({ timeout: 60_000 });
    await expect(again.getByLabel(/second person must decide a shortage/)).toHaveValue(limit);
    await expect(again.getByLabel(/How near counts as at the customer/)).toHaveValue('150');
    await expect(again.getByRole('checkbox', { name: /^Van sell/ })).toBeChecked();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
