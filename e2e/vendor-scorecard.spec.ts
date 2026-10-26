import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';
import { attemptTag, invoiceTool, makeVendor } from './support/vendors';

test.describe('the vendor scorecard', () => {
  test('shows a vendor with its ratings, takes a new rating, and lets the company add a criterion', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    invoiceTool('scorecard-review', vendor.vendorId);

    await open(page, '/admin/vendors/scorecards', 'Vendor scorecard');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const card = page.getByRole('list', { name: 'Scorecards' }).getByRole('listitem').filter({ hasText: vendor.legalName }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText('No score')).toBeVisible();
    await expect(page.getByRole('list', { name: `Parts of ${vendor.legalName}` }).getByText('60.0')).toBeVisible();

    const form = page.getByRole('form', { name: 'Rate the vendor' });
    await clickUntilVisible(card.getByRole('button', { name: `Rate ${vendor.legalName}` }), form);
    await form.getByRole('radio', { name: '5', exact: true }).first().check();
    await form.getByRole('button', { name: 'Save the rating' }).dispatchEvent('click');
    await expect(page.getByText('Rating saved.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('list', { name: `Parts of ${vendor.legalName}` }).getByText('80.0').first()).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);

    const add = page.getByRole('form', { name: 'Add a criterion' });
    await clickUntilVisible(page.getByRole('button', { name: 'What it is made of' }), add);
    await add.getByLabel('Name').fill(`Packaging ${tag}`);
    await add.getByRole('button', { name: 'Add a criterion' }).dispatchEvent('click');
    await expect(page.getByRole('list', { name: 'Criteria' }).getByText(`Packaging ${tag} ·`)).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
  });
});
