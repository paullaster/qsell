import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';
import { deliveryTool } from './support/delivery-fixtures';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

test.describe('a visit booked for the customer, on their own order page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the customer sees when, where and how it stands, never the crew contact or the notes, and sees it cancelled when the order is', async ({ page }, testInfo) => {
    test.slow();
    const shopper = makeShopper(attemptTag(testInfo.project.name, testInfo.retry), 1);
    const orderNumber = shopper.numbers[0] ?? '';
    deliveryTool('book-visit', orderNumber);
    // The customer was told it is booked.
    expect(deliveryTool('messages', orderNumber).list).toMatch(/visit_booked:/);
    await signInAsShopper(page, shopper);
    await page.goto('/profile/orders');
    const mine = page.getByRole('list', { name: 'Your orders' });
    await expect(mine.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    await mine.getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: `Order ${orderNumber}`, level: 2, exact: true })).toBeVisible({ timeout: 60_000 });

    const visit = page.getByRole('region', { name: 'Your visit' });
    await expect(visit).toBeVisible({ timeout: 30_000 });
    await expect(visit).toContainText('Kileleshwa, Nairobi, Gate 4');
    await expect(visit).toContainText('Booked. We will assign the crew before the visit.');
    // The day and the hours are written out, in the business's time zone.
    await expect(visit).toContainText(/\d{2}:\d{2} to \d{2}:\d{2}/);
    // What is for the crew stays with the crew.
    const body = await page.locator('main, body').first().innerText();
    expect(body).not.toContain('Dog in the yard');
    expect(body).not.toContain('0700123456');
    expect(body).not.toContain('Gate Keeper');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The order is cancelled, and the visit with it: the page says so.
    deliveryTool('cancel-order', orderNumber);
    deliveryTool('close-closed', 'x');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Your visit' })).toContainText('Cancelled.', { timeout: 60_000 });
    // The order's own cancellation is what the customer is told; the visit is closed with it quietly.
    expect(deliveryTool('messages', orderNumber).list).not.toMatch(/visit_cancelled:/);
  });
});
