import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import {
  clickUntilVisible,
  noHorizontalScroll,
  noInnerHorizontalScroll,
  noNativeSelect,
  open,
} from './support/page';

test.describe('refund limits', () => {
  test('are set with a picker, checked in words, saved, shown, and switched off again', async ({
    page,
  }) => {
    await open(page, '/admin/finance/refunds/limits', 'Refund limits');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const form = page.getByRole('form', { name: 'Change the refund limits' });
    await clickUntilVisible(page.getByRole('button', { name: 'Change', exact: true }), form);

    // Switched on with nothing to limit: said in words, nothing is sent.
    await form.getByLabel('Limit how fast refunds are asked for').check();
    // (the form opens with whatever was saved before, so empty every limit first)
    for (const name of [
      'Refunds per customer',
      'Money per customer',
      'Refunds per phone number or account',
      'Refunds per person asking',
      'Money per person asking',
    ]) {
      await form.getByLabel(name).fill('');
    }
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText('Set at least one limit, or switch the limits off.')).toBeVisible();

    // Nonsense is refused in words too.
    await form.getByLabel('Refunds per customer').fill('0');
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(
      page.getByText(/Refunds per customer must be a whole number of 1 or more/),
    ).toBeVisible();

    // A limit high enough never to trouble the other tests that ask for refunds.
    await form.getByLabel('Refunds per customer').fill('50');
    await form.getByLabel('Refunds per person asking').fill('500');
    await form.getByLabel('Money per customer').fill('1,000,000.50');
    await pick(
      page,
      form.getByRole('combobox', { name: 'Past a limit' }),
      'Hold',
      /Hold the refund for approval/,
    );
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText('Saved. It applies to refunds asked for from now on.')).toBeVisible(
      { timeout: 30_000 },
    );
    const inForce = page.getByRole('region', { name: 'Limits in force' });
    await expect(inForce).toContainText('50 per customer');
    await expect(inForce).toContainText('500 per person asking');
    await expect(inForce).toContainText('held for approval, whatever its amount');
    await expect(inForce.getByText('On', { exact: true })).toBeVisible();

    // Switched off again.
    await clickUntilVisible(page.getByRole('button', { name: 'Change', exact: true }), form);
    await form.getByLabel('Limit how fast refunds are asked for').uncheck();
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(inForce).toContainText('No limits', { timeout: 30_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);
  });
});
