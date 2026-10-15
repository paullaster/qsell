import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('number series', () => {
  test('a series is made, given a line with pickers, tried, and linked to a document after giving a reason', async ({ page }, testInfo) => {
    const code = `E2E${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-5)}`;
    await open(page, '/admin/settings/number-series', 'Number series');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    await page.getByRole('button', { name: 'New series' }).click();
    const form = page.getByRole('form', { name: 'New number series' });
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Description').fill(`E2E series ${code}`);
    await form.getByRole('button', { name: 'Create series' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(code), level: 2 })).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);

    // A line: the branch and the restart rule come from the server's lists, behind pickers.
    await page.getByRole('button', { name: 'Add line' }).click();
    const line = page.getByRole('form', { name: 'Add line' });
    await line.getByLabel('Prefix').fill(`${code}-`);
    await line.getByRole('combobox', { name: 'Applies to' }).click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await pick(page, line.getByRole('combobox', { name: 'Restart numbering' }), 'month', /Every month/);
    await expect(line.getByText(`${code}-000001`)).toBeVisible();
    await line.getByLabel('Prefix').fill(`${code}-{NOPE}`);
    await expect(line.getByRole('alert')).toBeVisible();
    await line.getByLabel('Prefix').fill(`${code}-`);
    await noHorizontalScroll(page);
    await line.getByRole('button', { name: 'Add line' }).click();
    await expect(page.getByText('Line added.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`${code}-000001`).first()).toBeVisible();
    await expect(page.getByText('Every month').first()).toBeVisible();

    // Try it: the number a document would get, without using one up.
    await page.getByRole('button', { name: 'Show next number' }).click();
    await expect(page.getByText(`${code}-000001`).last()).toBeVisible({ timeout: 30_000 });

    // Changing the settings asks for a reason from a picker.
    const settings = page.getByRole('form', { name: 'Series settings' });
    await expect(settings.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    await pick(page, settings.getByRole('combobox', { name: 'Reason' }), '', /./);
    await settings.getByLabel('Description').fill(`E2E series ${code} (changed)`);
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Series saved.')).toBeVisible({ timeout: 30_000 });

    // The list finds it by search and shows it page by page.
    await page.getByRole('link', { name: /All number series/ }).click();
    await page.getByLabel('Search number series').fill(code);
    await expect(page.getByRole('link', { name: new RegExp(code) })).toBeVisible({ timeout: 30_000 });

    // Linked to a document: pick the series, give a reason, confirm; then take it away again.
    await open(page, '/admin/settings/number-series/bindings', 'Document numbering');
    await noNativeSelect(page);
    const kind = page.getByRole('listitem').filter({ hasText: 'Stock count' }).first();
    await pick(page, kind.getByRole('combobox', { name: 'Default series for Stock count' }), code, new RegExp(code));
    const confirm = page.getByRole('region', { name: 'Confirm change' });
    await expect(confirm.getByText(new RegExp(`with ${code}`))).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
    await pick(page, confirm.getByRole('combobox', { name: 'Reason' }), '', /./);
    await confirm.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('Stock count numbering updated.')).toBeVisible({ timeout: 30_000 });
    await expect(kind.getByRole('combobox', { name: 'Default series for Stock count' })).toHaveValue(new RegExp(code));

    // A branch override: the branch list leaves out branches that already have one.
    await kind.getByText(/Branch overrides/).click();
    await kind.getByRole('button', { name: 'Add a branch override' }).click();
    await kind.getByRole('combobox', { name: 'Branch' }).click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page);

    // Put it back: removing the default asks for a reason too.
    await kind.getByRole('combobox', { name: 'Default series for Stock count' }).click();
    await page.keyboard.press('Escape');
    await kind.getByRole('combobox', { name: 'Default series for Stock count' }).clear();
  });
});
