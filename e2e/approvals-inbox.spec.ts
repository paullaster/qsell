import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

/** The seed leaves 27 documents waiting on the admin, sent by the admin (their step allows it). */
test.describe('approvals inbox and my requests', () => {
  test('the inbox shows a page, finds by text on the server, narrows to overdue and opens a review', async ({ page }) => {
    await open(page, '/admin/approvals/inbox', 'Approvals waiting on you');
    await noNativeSelect(page);
    await expect(page.getByText(/^\d+ waiting · \d+ overdue$/)).toBeVisible({ timeout: 30_000 });
    const list = page.getByRole('list', { name: 'Requests waiting on you' });
    await expect(list.getByRole('listitem')).toHaveCount(25);

    // The next page comes from the server, and the button goes when nothing is left.
    await clickUntilVisible(page.getByRole('button', { name: 'Show more requests' }), list.getByRole('listitem').nth(26));
    await expect(list.getByRole('listitem')).toHaveCount(27);
    await expect(page.getByRole('button', { name: 'Show more requests' })).toHaveCount(0);

    // Text is searched in the database, not in the page.
    await page.getByLabel('Search').fill('e2e-inbox-07');
    await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
    await expect(list.getByText('E2E-INBOX-07')).toBeVisible();
    await page.getByLabel('Search').fill('zzz-nothing');
    await expect(page.getByText('No requests match')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search').fill('');
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    // Nothing in the seed is overdue.
    await page.getByLabel('Overdue only').check();
    await expect(page.getByText('No requests match')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Overdue only').uncheck();

    // A review opens with its reasons and steps (it is not decided here).
    await page.getByLabel('Search').fill('E2E-INBOX-03');
    const card = list.getByRole('listitem').first();
    await expect(card).toContainText('E2E-INBOX-03', { timeout: 30_000 });
    // One click: a second would close the review again. (The screen is wired up by now: `open` waited for it.)
    await card.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText('Why this needs approval')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Approval steps')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('my requests show a page, narrow by status on the server and offer withdrawing', async ({ page }) => {
    await open(page, '/admin/approvals/requests', 'My requests');
    await noNativeSelect(page);
    const list = page.getByRole('list', { name: 'Your requests' });
    await expect(list.getByRole('listitem')).toHaveCount(25, { timeout: 30_000 });
    await clickUntilVisible(page.getByRole('button', { name: 'Show more requests' }), list.getByRole('listitem').nth(26));
    await expect(list.getByRole('listitem')).toHaveCount(27);
    await expect(list.getByRole('button', { name: 'Withdraw…' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(page.getByText('No requests here')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Approved', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Waiting', exact: true }).click();
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    // Asking to withdraw shows the question and can be backed out of.
    await list.getByRole('button', { name: 'Withdraw…' }).first().click();
    await expect(page.getByLabel('Why are you withdrawing this request?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Why are you withdrawing this request?')).toHaveCount(0);
    await noHorizontalScroll(page);
  });
});
