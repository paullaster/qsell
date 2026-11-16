import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

async function cartWithSalt(page: Page): Promise<void> {
  await page.goto('/?q=Salt 500g');
  const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test.describe('collecting an order, on the customer’s own page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a signed-in shopper who collects sees the branch and their code on their order page, and the code is the one the counter will ask for', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const branchName = deliveryTool('open', tag).branchName ?? '';
    const shopper = makeShopper(tag, 0);
    try {
      await signInAsShopper(page, shopper);
      await cartWithSalt(page);
      await page.goto('/checkout');
      const section = page.getByRole('group', { name: 'Where to deliver and what it costs' });
      await expect(section).toBeVisible({ timeout: 30_000 });
      await section.getByRole('radio', { name: 'Collect from a branch' }).check();
      const picker = page.getByRole('group', { name: 'Where to collect your order' });
      await picker.getByRole('radio', { name: new RegExp(branchName) }).check();
      await expect(picker.getByRole('status').filter({ hasText: `Collect from ${branchName}` })).toContainText('free', { timeout: 30_000 });
      await page.getByLabel(/number to pay from$/).fill('0733 555 666');
      await page.getByRole('button', { name: /^Pay / }).click();
      const failed = page.getByRole('region', { name: 'Payment not completed' });
      const waiting = page.getByRole('region', { name: 'Waiting for payment' });
      await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
      const text = await page.locator('main, body').first().innerText();
      const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1] ?? '';
      expect(orderNumber, 'the page names the order').toBeTruthy();

      // Their own order page: where to collect, and the code, which is the one the counter will check.
      await page.goto('/profile/orders');
      const mine = page.getByRole('list', { name: 'Your orders' });
      await expect(mine.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
      await mine.getByRole('link').first().click();
      await expect(page.getByRole('heading', { name: `Order ${orderNumber}`, level: 2, exact: true })).toBeVisible({ timeout: 60_000 });
      const where = page.getByRole('region', { name: 'Where your order is' });
      await expect(where).toContainText('Collecting your order', { timeout: 30_000 });
      await expect(where).toContainText(branchName);
      const code = deliveryTool('collection', orderNumber).code ?? '';
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      await expect(where.getByLabel(`Collection code ${code.split('').join(' ')}`)).toHaveText(`${code.slice(0, 3)}-${code.slice(3)}`);
      await noInnerHorizontalScroll(page);
      await noHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
