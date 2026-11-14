import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('customer messages', () => {
  test('texting customers is off to begin with, is turned on for the messages ticked, says where texts go, and is kept', async ({ page }) => {
    test.slow();
    await open(page, '/admin/delivery/messages', 'Customer messages');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const form = page.getByRole('form', { name: 'Customer texts' });
    const on = form.getByLabel('Also text customers');
    await expect(form.getByRole('status')).toContainText(/No SMS provider is connected|Texts go through the connection called/);
    // Whatever an earlier run left, start from off.
    if (await on.isChecked()) {
      await on.uncheck();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Customers are no longer texted' })).toBeVisible({ timeout: 30_000 });
    }
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(form.getByLabel(/^On its way/)).toBeDisabled();

    // Turned on with nothing ticked is refused in words; with some ticked it is saved.
    await on.check();
    // Nothing ticked at all, whatever an earlier run left ticked.
    for (const label of [/^On its way/, /^Delivered/, /^Part delivered/, /^Could not deliver/, /^Coming back/, /^Delivery time not kept/, /^Ready to collect/]) await form.getByLabel(label).uncheck();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Choose at least one message' })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel(/^On its way/).check();
    await form.getByLabel(/^Part delivered/).check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Customers are now texted for the messages ticked' })).toBeVisible({ timeout: 30_000 });
    await noInnerHorizontalScroll(page);

    // Quiet hours: half a pair is refused in words; a pair is saved and kept.
    await form.getByLabel('No texts from').fill('21:00');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Give both quiet hours' })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Texts resume at').fill('07:00');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Customers are now texted for the messages ticked' })).toBeVisible({ timeout: 30_000 });

    // Kept after a reload, then put back to off.
    await open(page, '/admin/delivery/messages', 'Customer messages');
    const again = page.getByRole('form', { name: 'Customer texts' });
    await expect(again.getByLabel('Also text customers')).toBeChecked();
    await expect(again.getByLabel(/^On its way/)).toBeChecked();
    await expect(again.getByLabel(/^Part delivered/)).toBeChecked();
    await expect(again.getByLabel(/^Delivered/)).not.toBeChecked();
    await expect(again.getByLabel('No texts from')).toHaveValue('21:00');
    await expect(again.getByLabel('Texts resume at')).toHaveValue('07:00');
    await again.getByLabel('No texts from').fill('');
    await again.getByLabel('Texts resume at').fill('');
    await again.getByLabel('Also text customers').uncheck();
    await again.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Customers are no longer texted' })).toBeVisible({ timeout: 30_000 });

    // Reminders for an order left at the counter: nonsense days are refused in words, good ones are kept, and the defaults are put back.
    const reminders = page.getByRole('form', { name: 'Reminders for orders left at the counter' });
    await expect(reminders.getByLabel('Send reminders')).toBeChecked();
    await expect(reminders.getByLabel('First reminder after (days)')).toHaveValue('3');
    await expect(reminders.getByLabel(/^Last reminder after/)).toHaveValue('6');
    await reminders.getByLabel('First reminder after (days)').fill('0');
    await reminders.getByRole('button', { name: 'Save the reminders' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'whole number from 1 to 30' })).toBeVisible({ timeout: 30_000 });
    await reminders.getByLabel('First reminder after (days)').fill('5');
    await reminders.getByLabel(/^Last reminder after/).fill('4');
    await reminders.getByRole('button', { name: 'Save the reminders' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'must come later than the first' })).toBeVisible({ timeout: 30_000 });
    await reminders.getByLabel(/^Last reminder after/).fill('');
    await reminders.getByRole('button', { name: 'Save the reminders' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Customers who leave an order at the counter are reminded' })).toBeVisible({ timeout: 30_000 });
    await open(page, '/admin/delivery/messages', 'Customer messages');
    const kept = page.getByRole('form', { name: 'Reminders for orders left at the counter' });
    await expect(kept.getByLabel('First reminder after (days)')).toHaveValue('5');
    await expect(kept.getByLabel(/^Last reminder after/)).toHaveValue('');
    await noInnerHorizontalScroll(page);
    await noHorizontalScroll(page);
    await kept.getByLabel('Send reminders').uncheck();
    await expect(kept.getByLabel('First reminder after (days)')).toBeDisabled();
    await kept.getByRole('button', { name: 'Save the reminders' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'no longer reminded' })).toBeVisible({ timeout: 30_000 });
    const back = page.getByRole('form', { name: 'Reminders for orders left at the counter' });
    await back.getByLabel('Send reminders').check();
    await back.getByLabel('First reminder after (days)').fill('3');
    await back.getByLabel(/^Last reminder after/).fill('6');
    await back.getByRole('button', { name: 'Save the reminders' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Customers who leave an order at the counter are reminded' })).toBeVisible({ timeout: 30_000 });
  });
});
