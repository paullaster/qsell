import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';

/** A transaction code the way M-Pesa writes one: ten capital letters and numbers, new for every call. */
const newCode = (): string => randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();

test.describe('a customer whose payment never reached us finishes the order', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sees the prompt on an unpaid order only, reads the order as it is, says they already paid or pays again, and cannot change anything', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const shopper = makeShopper(tag, 2, false, true);
    const [waiting, paid] = shopper.orderIds;
    const [waitingNumber] = shopper.numbers;
    await signInAsShopper(page, shopper);

    // An order that is already paid has nothing to complete: no prompt.
    await page.goto(`/profile/orders/${paid ?? ''}`);
    await expect(page.getByRole('heading', { level: 2, name: /^Order / }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Payment not received' })).toHaveCount(0);

    // The order that is waiting says so, and offers the way to finish it.
    await page.goto(`/profile/orders/${waiting ?? ''}`);
    await expect(page.getByRole('heading', { level: 2, name: `Order ${waitingNumber ?? ''}`, exact: true })).toBeVisible({ timeout: 60_000 });
    const prompt = page.getByRole('region', { name: 'Payment not received' });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(prompt).toContainText('We have not received the payment for this order yet.');
    await noHorizontalScroll(page);
    await prompt.getByRole('link', { name: 'Complete this order' }).click();

    // The order is shown as it is, with its status and everything on it, and nothing on it can be changed.
    await expect(page).toHaveURL(new RegExp(`/profile/orders/${waiting ?? ''}/pay$`), { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 2, name: `Order ${waitingNumber ?? ''}`, exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Order status' })).toContainText('Received');
    await expect(page.getByRole('region', { name: 'Items' })).toContainText('Solar lamp');
    await expect(page.getByRole('region', { name: 'Items' })).toContainText('1,160');
    await expect(page.getByRole('region', { name: 'Delivery address' })).toContainText('1 Moi Avenue');
    const recovery = page.getByRole('region', { name: 'Complete your payment' });
    await expect(recovery).toBeVisible({ timeout: 60_000 });
    await expect(recovery).toContainText('Your order cannot be changed here');
    await expect(page.getByRole('region', { name: 'Items' }).locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0);
    await expect(page.locator('main').getByRole('button', { name: /edit|change|remove|cancel/i })).toHaveCount(0);
    // Until a choice is made there is nothing to type into at all.
    await expect(page.locator('main').locator('input, textarea, select')).toHaveCount(0);
    await noNativeSelect(page);

    // "I have already paid": choose how, give the code. A code that cannot be one is refused in words before anything is asked.
    const claimButton = recovery.getByRole('button', { name: /I have already paid and have the transaction code/ });
    await claimButton.click();
    await expect(claimButton).toHaveAttribute('aria-expanded', 'true');
    const claim = page.getByRole('form', { name: 'I have already paid' });
    await expect(claim.getByRole('radio', { name: /M-Pesa/ })).toBeChecked();
    await claim.getByLabel('Transaction code').fill('ABC');
    await claim.getByRole('button', { name: 'Check my payment' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '10 letters and numbers' })).toBeVisible({ timeout: 30_000 });

    // A code that looks right goes to the shop's server, which asks the provider. With no bank behind the test shop it can only say it
    // is checking, or that it has kept the code for a person; it never says the order is paid.
    await claim.getByLabel('Transaction code').fill(newCode().toLowerCase());
    await claim.getByRole('button', { name: 'Check my payment' }).click();
    const answer = page.getByRole('status').filter({ hasText: /We are checking your payment|We cannot check payments|We have saved your code|no completed payment/ });
    await expect(answer.first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Thank you. We have your payment')).toHaveCount(0);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // "Pay again": choose how; a prompt can go to another phone; the order is still only read.
    const againButton = recovery.getByRole('button', { name: /^Pay again/ });
    await againButton.click();
    await expect(againButton).toHaveAttribute('aria-expanded', 'true');
    await expect(claimButton).toHaveAttribute('aria-expanded', 'false');
    const again = page.getByRole('form', { name: 'Pay again' });
    await expect(again.getByRole('radio', { name: /M-Pesa/ })).toBeChecked();
    await again.getByLabel('Mobile number to pay from (optional)').fill('0722 333 444');
    await again.getByRole('button', { name: /^Pay KES/ }).click();
    const started = page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /PIN|payment could not be started|started a moment ago|Complete the payment|Thank you/ });
    await expect(started.first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Items' }).locator('input, textarea, select')).toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('someone else’s order and an order that does not exist are not found, and a link that is not valid shows nothing', async ({ page, browser }, testInfo) => {
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const shopper = makeShopper(tag, 1, false, true);
    await signInAsShopper(page, shopper);
    await page.goto(`/profile/orders/${shopper.otherId}/pay`);
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Complete your payment' })).toHaveCount(0);
    await page.goto('/profile/orders/does-not-exist/pay');
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible({ timeout: 60_000 });

    const guest = await browser.newContext();
    try {
      const g = await guest.newPage();
      const response = await g.goto('/track/short/pay');
      expect(response?.status()).toBe(404);
      const unknown = await g.goto('/track/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/pay');
      expect(unknown?.status()).toBe(404);
      // Not signed in, the account page for the order asks for sign-in and shows no payment choices.
      await g.goto(`/profile/orders/${shopper.orderIds[0] ?? ''}/pay`);
      await expect(g.getByRole('region', { name: 'Complete your payment' })).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await guest.close();
    }
  });

  test('a shopper without an account finishes the order from the link in their message', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const shopper = makeShopper(tag, 1, false, true);
    expect(shopper.trackToken, 'the fixture gave the link of the waiting order').not.toBe('');
    const [number] = shopper.numbers;

    await page.goto(`/track/${shopper.trackToken}`);
    const prompt = page.getByRole('region', { name: 'Payment not received' });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole('link', { name: 'Complete this order' }).click();

    await expect(page).toHaveURL(new RegExp(`/track/${shopper.trackToken}/pay$`), { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 2, name: `Order ${number ?? ''}`, exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Items' })).toContainText('Solar lamp');
    const recovery = page.getByRole('region', { name: 'Complete your payment' });
    await expect(recovery).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Items' }).locator('input, textarea, select')).toHaveCount(0);

    await recovery.getByRole('button', { name: /I have already paid and have the transaction code/ }).click();
    const claim = page.getByRole('form', { name: 'I have already paid' });
    await claim.getByLabel('Transaction code').fill('12');
    await claim.getByRole('button', { name: 'Check my payment' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '10 letters and numbers' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
