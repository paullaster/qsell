import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { backfillStock, dropStockHolds, forgetStockFixtures, setLedger } from './support/stock-fixtures';

// The steps change a company-wide setting, so they run one after another, from the old way, and leave it as they found it.
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  setLedger('off');
  forgetStockFixtures();
});
test.afterAll(() => setLedger('off'));

test.describe('moving the company to the new stock ledger', () => {
  test('is done in steps with a check before the switch, and can be undone, and the screen fits every width', async ({ page }) => {
    test.slow();
    await open(page, '/admin/inventory/ledger', /Stock ledger/);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    const where = page.getByRole('region', { name: 'Where the company stands' });
    await expect(where).toContainText('The old way');

    // Step 1: the shadow starts, and the switch is not offered until every product is across.
    await page.getByRole('button', { name: 'Start the shadow' }).click();
    await expect(page.getByText('The shadow has started. Products are being brought across.')).toBeVisible({ timeout: 30_000 });
    await expect(where).toContainText('Shadow', { timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Step two' })).toContainText('still being brought across');
    await expect(page.getByRole('button', { name: /Switch to the new stock ledger/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled();

    // The worker brings the products across; here the test does it.
    backfillStock();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Step two' })).toContainText('Every product has been brought across', { timeout: 60_000 });

    // Step 3: the check says the two sides agree, and keeps the result.
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('Checked.')).toBeVisible({ timeout: 60_000 });
    const check = page.getByRole('region', { name: 'Latest check' });
    await expect(check).toContainText('Everything agrees', { timeout: 30_000 });
    await expect(check).toContainText('checked by hand');
    await noHorizontalScroll(page);

    // Step 4: the switch asks once, then happens.
    await page.getByRole('button', { name: /Switch to the new stock ledger/ }).click();
    await page.getByRole('button', { name: /^Confirm: Switch to the new stock ledger/ }).click();
    await expect(page.getByText('Switched. Stock is now kept in the new ledger.')).toBeVisible({ timeout: 90_000 });
    await expect(where).toContainText('The new ledger', { timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Latest check' })).toContainText('at the switch');

    // The screens that need the new ledger now work.
    await open(page, '/admin/inventory/transfers', /Stock transfers/);
    await expect(page.getByRole('link', { name: 'New transfer' })).toBeVisible({ timeout: 30_000 });

    // Going back is refused while orders still hold stock (other specs leave some open), so they are let go first.
    dropStockHolds();
    // Going back needs a reason.
    await open(page, '/admin/inventory/ledger', /Stock ledger/);
    const back = page.getByRole('region', { name: 'Going back' });
    await back.getByRole('button', { name: 'Go back to the old way' }).click();
    await back.getByRole('button', { name: /^Confirm: Go back to the old way/ }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/Say why/, { timeout: 30_000 });
    await back.getByLabel('Why go back').fill('Looking at a report before we carry on');
    // The confirmation closes after each answer, so it is opened again now that there is a reason.
    await back.getByRole('button', { name: 'Go back to the old way' }).click();
    await back.getByRole('button', { name: /^Confirm: Go back to the old way/ }).click();
    await expect(page.getByText('Back to the old way.')).toBeVisible({ timeout: 30_000 });
    await expect(where).toContainText('The old way', { timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
