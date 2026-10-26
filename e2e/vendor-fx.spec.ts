import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, open } from './support/page';

test.describe('what is owed in other currencies', () => {
  test('the payables page offers the revaluation and says plainly when there is nothing to revalue', async ({ page }) => {
    test.slow();
    await open(page, '/admin/vendors/payables', 'What we owe');
    await noHorizontalScroll(page);
    const section = page.getByRole('region', { name: 'What is owed in other currencies' });
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section.getByText(/carried at the rate of the day they were booked/)).toBeVisible();
    await clickUntilVisible(section.getByRole('button', { name: 'Revalue at today’s rate' }), section.getByRole('alert'));
    await expect(section.getByRole('alert')).toContainText(/Nothing is owed to vendors in another currency|already revalued|worth what the books carry/);
    await noHorizontalScroll(page);
  });
});
