import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { sentQuoteFor } from './support/quote-fixture';

test.describe('the customer\'s quote link', () => {
  test('tells the customer the quote was accepted, keeps saying so when the link is opened again, and leads on to the shop', async ({ page }, info) => {
    const quote = sentQuoteFor(`${info.project.name}${String(Date.now()).slice(-6)}`, 'credit');
    await page.goto(`/quote/${quote.token}`);
    await expect(page.getByRole('heading', { name: quote.number, level: 1 })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);

    // A click before the page is wired up is lost, so it is repeated until the answer is there.
    const outcome = page.getByTestId('quote-outcome');
    await expect(async () => {
      await page.getByRole('button', { name: 'Accept quote' }).click({ timeout: 3_000 });
      await expect(outcome).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 90_000 });
    await expect(outcome.getByRole('heading', { name: 'Quote accepted successfully' })).toBeVisible();
    await expect(outcome).toContainText(quote.number);
    await expect(page.getByText('Page not found')).toHaveCount(0);
    await expect(outcome.getByTestId('quote-browse')).toHaveAttribute('href', '/');
    await noHorizontalScroll(page);

    // Opening the same link again (the email, a refresh) says the same, never a missing page.
    await page.reload();
    await expect(page.getByTestId('quote-outcome').getByRole('heading', { name: 'Quote accepted successfully' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Page not found')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Accept quote' })).toHaveCount(0);

    // The call to action goes to the shop's catalogue.
    await expect(async () => {
      await page.getByTestId('quote-browse').click();
      await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
  });

  test('a declined quote and an unknown link are told apart', async ({ page }, info) => {
    const quote = sentQuoteFor(`${info.project.name}${String(Date.now()).slice(-6)}`, 'cash');
    await page.goto(`/quote/${quote.token}`);
    await expect(page.getByRole('heading', { name: quote.number, level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      await page.getByRole('button', { name: 'Decline quote' }).click({ timeout: 3_000 });
      await expect(page.getByTestId('quote-outcome')).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Quote declined' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Quote declined' })).toBeVisible({ timeout: 60_000 });

    // Only an address that is not a quote link at all is missing.
    const missing = await page.goto(`/quote/${'e'.repeat(64)}`);
    expect(missing?.status()).toBe(404);
  });
});
