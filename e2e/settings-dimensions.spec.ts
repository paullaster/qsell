import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('dimensions', () => {
  test('a dimension is made with pickers, found by search, given a value, and removed after asking', async ({ page }, testInfo) => {
    const code = `E2E${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/dimensions', 'Dimensions');
    await noNativeSelect(page);

    const form = page.getByRole('form', { name: 'New dimension' });
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill(`E2E ${code}`);
    // The option string comes from the server's list, one page at a time, behind a picker. Each option can belong to one
    // dimension only, so a retry (after a failed first try left one behind) does without.
    const optionName = testInfo.project.name === 'phone' ? 'Site' : 'Warehouse';
    if (testInfo.retry === 0) {
      await form.getByRole('combobox', { name: 'Option string' }).click();
      await expect(page.getByRole('option', { name: optionName })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('option', { name: optionName }).click();
    }
    // Ticking "default" makes it global and switches off shortcut.
    await form.getByLabel('Default').check();
    await expect(form.getByLabel('Global')).toBeChecked();
    await expect(form.getByLabel('Global')).toBeDisabled();
    // A number is needed for a default dimension: the form says so before anything is sent.
    await form.getByRole('button', { name: 'Create dimension' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /dimension number is needed/i })).toBeVisible();
    await form.getByLabel(/Dimension number/).fill(String(100 + (Date.now() % 800)));
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Create dimension' }).click();
    await expect(page.getByText('Dimension created.')).toBeVisible({ timeout: 30_000 });

    // The list is searched on the server.
    await page.getByLabel('Search dimensions').fill(code);
    const row = page.getByRole('listitem').filter({ hasText: `E2E ${code}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('group', { name: `Flags of ${code}` })).toBeVisible();

    // The same code is refused with words, not a blank error.
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill('again');
    await form.getByRole('button', { name: 'Create dimension' }).click();
    await expect(page.getByText(/already exists/)).toBeVisible({ timeout: 30_000 });

    // A value is added, with a parent picked from the server's list.
    await row.getByRole('link', { name: `Values of ${code}` }).click();
    await expect(page.getByRole('heading', { name: new RegExp(code), level: 2 })).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);
    const valueForm = page.getByRole('form', { name: 'New value' });
    for (const v of ['A1', 'A2']) {
      await valueForm.getByLabel('Code').fill(v);
      await valueForm.getByLabel('Name').fill(`Value ${v}`);
      if (v === 'A2') await pick(page, valueForm.getByRole('combobox', { name: 'Parent value' }), 'A1', /A1/);
      await valueForm.getByRole('button', { name: 'Create value' }).click();
      await expect(page.getByText('Value created.')).toBeVisible({ timeout: 30_000 });
    }
    const second = page.getByRole('listitem').filter({ hasText: 'Value A2' });
    await expect(second.getByText(/Under .*A1/)).toBeVisible({ timeout: 30_000 });
    await second.getByRole('button', { name: 'Switch off A2' }).click();
    await expect(page.getByText('A2 is switched off.')).toBeVisible({ timeout: 30_000 });

    // Deleting asks first, in place; "Keep it" changes nothing, and the second press does it.
    await second.getByRole('button', { name: 'Delete value A2' }).click();
    await second.getByRole('button', { name: 'Keep it' }).focus();
    await page.keyboard.press('Enter');
    await expect(second.getByRole('button', { name: 'Delete value A2' })).toBeVisible();
    await clickUntilVisible(second.getByRole('button', { name: 'Delete value A2' }), second.getByRole('button', { name: 'Confirm: Delete value A2' }));
    await second.getByRole('button', { name: 'Confirm: Delete value A2' }).click();
    await expect(page.getByText('A2 deleted.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Value A2' })).toHaveCount(0);

    // Back to the list: the dimension is removed with its values.
    await page.getByRole('link', { name: /All dimensions/ }).click();
    await page.getByLabel('Search dimensions').fill(code);
    const again = page.getByRole('listitem').filter({ hasText: `E2E ${code}` });
    await clickUntilVisible(again.getByRole('button', { name: `Delete dimension ${code}` }), again.getByRole('button', { name: `Confirm: Delete dimension ${code}` }));
    await again.getByRole('button', { name: `Confirm: Delete dimension ${code}` }).click();
    await expect(page.getByText(`${code} deleted.`)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('the customer shortcut route opens a dimension form as a dialog on its own page too', async ({ page }) => {
    await open(page, '/admin/settings/dimensions/new', /Create dimension/);
    await noNativeSelect(page);
    await page.getByRole('combobox', { name: 'Use on customers as' }).click();
    await expect(page.getByRole('option', { name: 'Shortcut dimension' })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page);
  });
});
