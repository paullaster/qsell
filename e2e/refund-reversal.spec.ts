import { expect, test } from '@playwright/test';
import {
  clickUntilVisible,
  noHorizontalScroll,
  noInnerHorizontalScroll,
  noNativeSelect,
  open,
} from './support/page';

test.describe("paying a refund by reversing the customer's M-Pesa payment", () => {
  test('is offered for a refund of exactly what was paid, asks first, and sends the reversal', async ({
    page,
  }, testInfo) => {
    const who = testInfo.project.name === 'phone' ? 'Phone' : 'Desktop';
    await open(page, '/admin/finance/refunds', 'Refunds');
    await page.getByText(`Reversal ${who}`).first().click();
    await expect(page.getByRole('heading', { name: /^Refund /, level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await noNativeSelect(page);

    // Offered, because the customer's payment is known and the refund is for all of it, through the same M-Pesa connection.
    const reverse = page.getByRole('button', { name: /Reverse the customer.s M-Pesa payment/ });
    await expect(reverse).toBeVisible({ timeout: 30_000 });
    const confirm = page.getByRole('region', { name: "Reverse the customer's payment" });
    await clickUntilVisible(reverse, confirm);
    await expect(confirm).toContainText('whole payment');
    await expect(confirm).toContainText(/cannot be undone/);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Keeping it closes the question and sends nothing.
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(confirm).toBeHidden();

    await clickUntilVisible(reverse, confirm);
    await confirm.getByRole('button', { name: 'Reverse it' }).click();
    await expect(page.getByText(/Reversal sent to M-Pesa/)).toBeVisible({ timeout: 30_000 });
    // The request is written down in the refund's history with who asked. (Nothing answers from Safaricom in this test, so the
    // reversal fails and may be tried again; while one is waiting for an answer it is not offered a second time.)
    await expect(page.getByText(/reversal requested/i).first()).toBeVisible({ timeout: 30_000 });
  });
});
