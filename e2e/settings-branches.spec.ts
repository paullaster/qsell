import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('branches', () => {
  test('a branch is added, found by search, marked independent, and made the default and back', async ({ page }, testInfo) => {
    const code = `B${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/branches', 'Branches');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const list = page.getByRole('list', { name: 'Branches' });
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    const original = list.getByRole('listitem').filter({ hasText: 'Default' }).first();
    const originalName = (await original.locator('p').first().innerText()).split('·')[1]?.replace('Default', '').trim() ?? '';

    const form = page.getByRole('form', { name: 'Add branch' });
    await form.getByLabel('Code').fill('bad code!');
    await form.getByLabel('Name').fill(`E2E ${code}`);
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /code is up to 20/i })).toBeVisible();
    await form.getByLabel('Code').fill(code.toLowerCase());
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText(`E2E ${code} added.`)).toBeVisible({ timeout: 30_000 });

    // The same code again is refused with words.
    await expect(form.getByRole('button', { name: 'Create branch' })).toBeEnabled();
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill('again');
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText('A branch with that code already exists.')).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Search branches').fill(code);
    const row = list.getByRole('listitem').filter({ hasText: `E2E ${code}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByLabel(`E2E ${code} acts independently`).click();
    await expect(page.getByText(`E2E ${code} updated.`)).toBeVisible({ timeout: 30_000 });
    await expect(row.getByLabel(`E2E ${code} acts independently`)).toBeChecked();

    await row.getByRole('button', { name: `Make E2E ${code} the default` }).click();
    await expect(page.getByText(`E2E ${code} is now the default.`)).toBeVisible({ timeout: 30_000 });
    // Put the default back where it was, so nothing else is disturbed.
    await page.getByLabel('Search branches').fill(originalName);
    const back = list.getByRole('listitem').filter({ hasText: originalName }).first();
    await back.getByRole('button', { name: /Make .* the default/ }).click();
    await expect(page.getByText(/is now the default\./).first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
