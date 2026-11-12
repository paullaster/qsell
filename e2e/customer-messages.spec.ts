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
  });
});
