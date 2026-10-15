import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('KRA and tax settings', () => {
  test('company mode: the choices are pickers, the device settings follow the mode, and a save is confirmed', async ({ page }) => {
    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/company', 'Company mode');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const form = page.getByRole('form', { name: 'Company KRA mode' });
    await clickUntilVisible(form.getByRole('combobox', { name: 'Environment' }), page.getByRole('option', { name: 'Production' }));
    await page.keyboard.press('Escape');
    await form.getByRole('radio', { name: /^TIMS/ }).check();
    await expect(form.getByRole('combobox', { name: 'Device connection' })).toBeVisible();
    await form.getByRole('combobox', { name: 'Device connection' }).click();
    await expect(page.getByRole('option', { name: 'Serial (COM)' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: 'Serial (COM)' }).click();
    await form.getByRole('radio', { name: /^eTIMS/ }).check();
    await expect(form.getByLabel('eTIMS gateway URL')).toBeVisible();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Company KRA mode saved.')).toBeVisible({ timeout: 30_000 });
  });

  test('branch modes: an independent branch gets its own form, with "follow the company" choices', async ({ page }, testInfo) => {
    const code = `K${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/branches', 'Branches');
    const add = page.getByRole('form', { name: 'Add branch' });
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.getByLabel('Code').fill(code);
    await add.getByLabel('Name').fill(`E2E ${code}`);
    await add.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText(`E2E ${code} added.`)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search branches').fill(code);
    const row = page.getByRole('list', { name: 'Branches' }).getByRole('listitem').filter({ hasText: `E2E ${code}` });
    await row.getByLabel(`E2E ${code} acts independently`).click();
    await expect(page.getByText(`E2E ${code} updated.`)).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/branches', 'Branch modes');
    await noNativeSelect(page);
    await page.getByLabel('Search branches').fill(code);
    const form = page.getByRole('form', { name: `E2E ${code} KRA mode` });
    await expect(form).toBeVisible({ timeout: 30_000 });
    const signing = form.getByRole('combobox', { name: /Sales orders signing for this branch/ });
    await expect(signing).toHaveValue(/Use company setting/);
    await signing.click();
    await expect(page.getByRole('option', { name: 'On for this branch' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: 'On for this branch' }).click();
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`E2E ${code} KRA mode saved.`)).toBeVisible({ timeout: 30_000 });
  });

  test('the signing log opens with a result picker and a search, a page at a time', async ({ page }) => {
    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/signing-log', 'Signing log');
    await noNativeSelect(page);
    await page.getByRole('combobox', { name: 'Latest result' }).click();
    await expect(page.getByRole('option', { name: 'Signed', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('option', { name: 'Waiting on original' })).toBeVisible();
    await page.getByRole('option', { name: 'Failed', exact: true }).click();
    await page.getByLabel('Find a document').fill('no-such-order');
    await expect(page.getByText('No documents match.')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('eTIMS items: the place and the product come from the server, and nothing is registered without a tax code', async ({ page }) => {
    // eTIMS has to be set up for the items screen to offer anything; the credentials are only stored, never used here.
    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/company', 'Company mode');
    const mode = page.getByRole('form', { name: 'Company KRA mode' });
    await mode.getByRole('radio', { name: /^eTIMS/ }).check();
    await mode.getByLabel('eTIMS gateway URL').fill('https://etims.example.test/api');
    await mode.getByLabel('Username').fill('e2e-user');
    await mode.getByLabel('Password').fill('e2e-pass');
    await mode.getByLabel('Enabled').check();
    await mode.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Company KRA mode saved.')).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/items', 'eTIMS items');
    await noNativeSelect(page);
    await page.getByRole('combobox', { name: 'Register items for' }).click();
    await expect(page.getByRole('option', { name: /Company/ })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    const register = page.getByRole('form', { name: 'Register item' });
    await expect(register.getByRole('button', { name: 'Register with KRA' })).toBeDisabled();
    await register.getByRole('combobox', { name: 'Product' }).click();
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search registered items')).toBeVisible();
    await noHorizontalScroll(page);

    // Put the company back to not using eTIMS.
    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/company', 'Company mode');
    await mode.getByLabel('Enabled').uncheck();
    await mode.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Company KRA mode saved.')).toBeVisible({ timeout: 30_000 });
  });

  test('tax classification: a rule is made with pickers, found, tried in the calculator, changed and removed after asking', async ({ page }, testInfo) => {
    const name = `E2E Tax ${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/tax-compliance/kra-tims-etims/classification', 'Tax & compliance management');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'New tax rule' });
    // The first rule ever made becomes the default, and the default cannot be deleted; so make sure another one exists first.
    await clickUntilVisible(page.getByRole('button', { name: 'Add tax rule' }), form);
    await form.getByLabel('Tax schedule / category name').fill(`Base rule ${String(Date.now())}`);
    await form.getByLabel('Tax code').fill(`B${String(Date.now()).slice(-8)}`);
    await form.getByLabel('Rate (%)').fill('1');
    await form.getByRole('button', { name: 'Create tax rule' }).click();
    await expect(page.getByText(/^Base rule \d+ saved\.$/)).toBeVisible({ timeout: 30_000 });
    await clickUntilVisible(page.getByRole('button', { name: 'Add tax rule' }), form);
    await form.getByLabel('Tax schedule / category name').fill(name);
    await form.getByLabel('Tax code').fill(`T${String(Date.now()).slice(-8)}`);
    await form.getByLabel('Rate (%)').fill('12.5');
    await pick(page, form.getByRole('combobox', { name: 'KRA TIMS code' }), 'A', /A — 16%/);
    await pick(page, form.getByRole('combobox', { name: 'KRA eTIMS code' }), 'B', /B — 16%/);
    await form.getByRole('combobox', { name: 'Fiscal tax type' }).click();
    await expect(page.getByRole('option', { name: 'Excise Duty' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: 'Excise Duty' }).click();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Create tax rule' }).click();
    await expect(page.getByText(`${name} saved.`)).toBeVisible({ timeout: 30_000 });

    // Found by search, and narrowed by the type picker.
    await page.getByLabel('Search tax rules').fill(name);
    const rules = page.getByRole('list', { name: 'Tax rules' });
    const row = rules.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await pick(page, page.getByRole('combobox', { name: 'Tax type', exact: true }), 'Excise', /Excise Duty/);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await pick(page, page.getByRole('combobox', { name: 'Tax type', exact: true }), 'Sales', /Sales Tax/);
    await expect(rules.getByRole('listitem').filter({ hasText: name })).toHaveCount(0, { timeout: 30_000 });
    await pick(page, page.getByRole('combobox', { name: 'Tax type', exact: true }), 'Excise', /Excise Duty/);
    await expect(row).toBeVisible({ timeout: 30_000 });

    // The calculator works from the rule chosen in its own picker.
    const calc = page.getByRole('region', { name: 'Tax calculator' });
    await pick(page, calc.getByRole('combobox', { name: 'Tax schedule' }), name, new RegExp(name));
    await calc.getByLabel('Amount (KSh)').fill('1000');
    await expect(calc.getByText('KSh 888.89')).toBeVisible();

    // Change it, then remove it after being asked.
    await page.getByLabel('Search tax rules').fill(name);
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('form', { name: 'Edit tax rule' });
    await edit.getByLabel('Rate (%)').fill('10');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`${name} saved.`)).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/^10% ·/)).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await row.getByRole('button', { name: 'Keep it' }).focus();
    await page.keyboard.press('Enter');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await row.getByRole('button', { name: `Confirm: Delete ${name}` }).click();
    await expect(page.getByText(`${name} deleted.`)).toBeVisible({ timeout: 30_000 });
  });
});
