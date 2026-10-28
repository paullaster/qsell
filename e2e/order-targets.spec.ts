import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { makeLateOrder } from './support/storefront-fixtures';
import { attemptTag } from './support/vendors';

const row = (page: Page, stageLabel: string): Locator => page.getByRole('listitem').filter({ has: page.getByText(`Watch “${stageLabel}”`) });

test.describe('how long an order may wait in each stage', () => {
  test('targets are edited, remembered and checked, and nothing is saved when one is wrong', async ({ page }) => {
    test.slow();
    await open(page, '/admin/settings/order-targets', /Order targets/);
    const payment = row(page, 'Payment started');
    await expect(payment).toBeVisible({ timeout: 60_000 });
    await expect(payment.getByRole('textbox', { name: 'Late after (minutes)', exact: true })).toHaveValue('30');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A target that is too short is refused in words, and nothing is saved.
    await payment.getByRole('textbox', { name: 'Late after (minutes)', exact: true }).fill('3');
    await page.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(/Payment started: the target must be a whole number of minutes/, { timeout: 30_000 });

    // A good change is saved, with the people to tell.
    await payment.getByRole('textbox', { name: 'Late after (minutes)', exact: true }).fill('45');
    await payment.getByRole('textbox', { name: 'Then escalate after (minutes)', exact: true }).fill('20');
    await expect(payment.getByText('45 min')).toBeVisible();
    await page.getByLabel('When an order is late').fill('ops@example.test');
    await page.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.getByText(/Saved\. The new targets apply/)).toBeVisible({ timeout: 30_000 });

    // It is still there after a reload.
    await open(page, '/admin/settings/order-targets', /Order targets/);
    await expect(row(page, 'Payment started').getByRole('textbox', { name: 'Late after (minutes)', exact: true })).toHaveValue('45', { timeout: 60_000 });
    await expect(row(page, 'Payment started').getByRole('textbox', { name: 'Then escalate after (minutes)', exact: true })).toHaveValue('20');
    await expect(page.getByLabel('When an order is late')).toHaveValue('ops@example.test');

    // A bad address is named, and the old list stays.
    await page.getByLabel('When an order is late').fill('ops@example.test\nnot-an-address');
    await page.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(/"not-an-address" is not an email address/, { timeout: 30_000 });

    // Put the defaults back so the other tests start from the same place.
    await open(page, '/admin/settings/order-targets', /Order targets/);
    const again = row(page, 'Payment started');
    await again.getByRole('textbox', { name: 'Late after (minutes)', exact: true }).fill('30');
    await again.getByRole('textbox', { name: 'Then escalate after (minutes)', exact: true }).fill('15');
    await page.getByLabel('When an order is late').fill('');
    await page.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.getByText(/Saved\. The new targets apply/)).toBeVisible({ timeout: 30_000 });
  });

  test('a late order is listed in the order flow with how long it has waited, and a person can say they are on it', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const orderNumber = makeLateOrder(tag, 3);
    await open(page, '/admin/orders', /Customer Orders/);
    const flow = page.getByLabel('Order flow');
    await expect(flow).toBeVisible({ timeout: 60_000 });
    await flow.getByText(/Order flow, last 7 days/).click();
    const late = flow.getByRole('region', { name: 'Late orders' });
    await expect(late).toBeVisible({ timeout: 30_000 });
    const item = late.getByRole('listitem').filter({ hasText: orderNumber });
    await expect(item).toContainText(/payment started for 3 h/i);
    await expect(item).toContainText(/target 30 min/);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    await item.getByRole('button', { name: 'I am on it' }).click();
    await expect(item).toContainText('someone is on it', { timeout: 30_000 });
    await expect(item.getByRole('button', { name: 'I am on it' })).toHaveCount(0);
  });
});
