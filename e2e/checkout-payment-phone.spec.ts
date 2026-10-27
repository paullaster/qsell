import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll } from './support/page';
import { storefrontTool } from './support/storefront-fixtures';

/** Puts one product in the cart and opens the checkout with the details filled in. */
async function fillCheckout(page: Page, contactPhone: string): Promise<void> {
  await page.goto('/?q=Salt 500g');
  const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await add.click();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Full name').fill('Wanjiru Pay');
  await page.getByLabel('Mobile phone').fill(contactPhone);
  await page.getByLabel('Street, building or office').fill('1 Moi Avenue');
  await page.getByLabel('City or town').fill('Nairobi');
}

const payFrom = (page: Page) => page.getByLabel(/number to pay from$/);

test.describe('paying from a different phone', () => {
  test('the pay-from field follows the contact number, accepts another line, and refuses what is not a mobile number', async ({ page }) => {
    await fillCheckout(page, '0711 000 111');
    const field = payFrom(page);
    await expect(field).toBeVisible({ timeout: 30_000 });
    // Empty means: the contact number, shown as the hint inside the box.
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', '0711 000 111');
    await expect(page.getByRole('button', { name: 'Use my contact number instead' })).toBeHidden();

    await field.fill('0722 333 444');
    await expect(page.getByText('We keep this number with your order')).toBeVisible();
    await page.getByRole('button', { name: 'Use my contact number instead' }).click();
    await expect(field).toHaveValue('');

    // Nothing is placed for something that cannot be a Kenyan mobile number.
    await field.fill('12345');
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.locator('form').getByRole('alert')).toContainText('That is not a Kenyan mobile number. Enter the number to pay from, like 0712 345 678.');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('the number the customer paid from is kept with the order, apart from the contact number, and can be changed on a retry', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name}${String(testInfo.retry)}`;
    const contact = tag.startsWith('phone') ? '0711 000 222' : '0711 000 333';
    await fillCheckout(page, contact);
    await payFrom(page).fill('0722 333 444');
    await page.getByRole('button', { name: /^Pay / }).click();

    // No bank is behind the test shop, so the prompt cannot be confirmed: the shop says the payment did not go through and keeps the order.
    const failed = page.getByRole('region', { name: 'Payment not completed' });
    const waiting = page.getByRole('region', { name: 'Waiting for payment' });
    await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
    const text = await page.locator('main, body').first().innerText();
    const orderNumber = /order\s+([A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(text)?.[1];
    expect(orderNumber, 'the page names the order').toBeTruthy();

    // The number chosen is on the order from the moment it is placed, apart from the contact number.
    const kept = storefrontTool('payment-phones', orderNumber ?? '');
    expect(kept.contact).toBe(contact);
    expect(kept.paidFrom).toBe('254722333444');
    // Every prompt that was sent is on its own attempt with its own number. (Without a bank behind the test shop none may have started.)
    const sent = (attempts: string): string[] => attempts.split(',').filter((value) => value !== '');
    expect(sent(kept.attempts).every((value) => value === '254722333444')).toBe(true);

    if (await failed.isVisible()) {
      // A wrong number is the usual reason: try again from another.
      await expect(page.getByLabel('Try again from a different number')).toBeVisible();
      await page.getByLabel('Try again from a different number').fill('0733 555 666');
      await page.getByRole('button', { name: 'Try the payment again' }).click();
      await expect(failed.or(waiting)).toBeVisible({ timeout: 90_000 });
      const after = storefrontTool('payment-phones', orderNumber ?? '');
      expect(after.contact).toBe(contact);
      const attempts = sent(after.attempts);
      // A prompt that really went out to the new number is kept with it, and the order then shows it as the number paid from.
      if (attempts.includes('254733555666')) {
        expect(attempts.at(-1)).toBe('254733555666');
        expect(after.paidFrom).toBe('254733555666');
      } else {
        expect(after.paidFrom).toBe('254722333444');
      }
    }
  });
});
