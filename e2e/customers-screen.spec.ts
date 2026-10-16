import { expect, test, type Page } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect } from './support/page';

async function openCustomers(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto('/admin/customers');
    try {
      const title = page.getByRole('heading', { name: 'Customers', level: 2 }).first();
      await expect(title).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => title.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 30_000 }).toBe(true);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

test.describe('customers screen', () => {
  test('the list is paged and searched on the server, a customer is made, found, changed and deleted after asking', async ({ page, isMobile }, testInfo) => {
    const stamp = `${testInfo.project.name}${String(Date.now()).slice(-6)}`;
    const name = `E2E Card ${stamp}`;
    await openCustomers(page);
    await noNativeSelect(page);
    // A phone shows the customers as cards, a wider screen as a table with a header row.
    const table = isMobile ? page.getByRole('list', { name: 'Customers' }) : page.getByRole('table', { name: 'Customers' });
    const rows = isMobile ? table.getByRole('listitem') : table.getByRole('row');
    const header = isMobile ? 0 : 1;
    await expect(rows).toHaveCount(25 + header, { timeout: 30_000 }); // one page of 25
    // The button sits at the very bottom of a long phone page; press it from the keyboard, as a keyboard user would.
    const more = page.getByRole('button', { name: 'Show more customers' });
    await expect(async () => {
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(rows.nth(25 + header)).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });

    // Text is searched in the database.
    await page.getByLabel('Search customers').fill('E2E001');
    await expect(rows).toHaveCount(1 + header, { timeout: 30_000 });
    await page.getByLabel('Search customers').fill('no-such-customer-zzz');
    await expect(page.getByText(/No customers match/).locator('visible=true')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search customers').fill('');

    // A new card: the type is a picker, credit terms matter only for credit.
    await page.getByRole('button', { name: 'New customer' }).click();
    const card = page.getByRole('form', { name: 'New customer card' });
    await expect(card).toBeVisible();
    await noNativeSelect(page);
    await card.getByLabel('Name', { exact: true }).fill(name);
    await card.getByLabel('Email').fill(`card-${stamp.toLowerCase()}@example.test`);
    await pick(page, card.getByRole('combobox', { name: 'Account type' }), 'Credit', /Credit \(pays later\)/);
    await expect(card.getByLabel('Credit limit')).toBeEnabled();
    await card.getByLabel('Credit limit').fill('750');
    await card.getByLabel('Payment terms (days)').fill('14');
    await pick(page, card.getByRole('combobox', { name: 'Blocked' }), 'Cannot be invoiced', /Cannot be invoiced/);
    await card.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} saved.` })).toBeVisible({ timeout: 30_000 });

    // Found, opened, and kept as saved.
    await page.getByLabel('Search customers').fill(stamp);
    await expect(rows).toHaveCount(1 + header, { timeout: 30_000 });
    await table.getByRole('button', { name: `Open ${name}` }).click();
    const again = page.getByRole('form', { name: 'Customer card' });
    await expect(again.getByLabel('Credit limit')).toHaveValue('750.00', { timeout: 30_000 });
    await expect(again.getByRole('combobox', { name: 'Blocked' })).toHaveValue(/invoiced/i);

    // Deleting asks first, and "Keep it" changes nothing.
    await table.getByRole('button', { name: `Delete ${name}` }).click();
    await table.getByRole('button', { name: 'Keep it' }).click();
    await expect(rows).toHaveCount(1 + header);
    await clickUntilVisible(table.getByRole('button', { name: `Delete ${name}` }), table.getByRole('button', { name: `Confirm: Delete ${name}` }));
    await table.getByRole('button', { name: `Confirm: Delete ${name}` }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} deleted.` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/No customers match/).locator('visible=true')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('profiles: one is made with a picker for its type, found and listed', async ({ page, isMobile }, testInfo) => {
    const code = `EP${testInfo.project.name.slice(0, 1).toUpperCase()}${String(Date.now()).slice(-6)}`;
    await openCustomers(page);
    await clickUntilVisible(page.getByRole('tab', { name: 'profiles' }), page.getByLabel('Search profiles'));
    await page.getByRole('button', { name: 'New profile' }).click();
    const form = page.getByRole('form', { name: 'New profile' });
    await expect(form).toBeVisible();
    await noNativeSelect(page);
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name', { exact: true }).fill(`Profile ${code}`);
    await pick(page, form.getByRole('combobox', { name: 'Account type' }), 'Credit', /Credit \(pays later\)/);
    await form.getByLabel('Credit limit').fill('900');
    await form.getByLabel('Payment terms (days)').fill('21');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Profile ${code} saved.` })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search profiles').fill(code);
    const table = isMobile ? page.getByRole('list', { name: 'Customer profiles' }) : page.getByRole('table', { name: 'Customer profiles' });
    await expect(isMobile ? table.getByRole('listitem') : table.getByRole('row')).toHaveCount(isMobile ? 1 : 2, { timeout: 30_000 });
    await expect(table.getByText('21 days')).toBeVisible();
    await noHorizontalScroll(page);
  });
});
