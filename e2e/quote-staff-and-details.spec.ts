import { expect, test } from '@playwright/test';
import { gotoAdmin, openNewQuote } from './support/quotes';
import { noHorizontalScroll } from './support/page';

test.describe('who made and who emailed a quote, and the customer details on it', () => {
  test('the list names the staff who made each quote and says when none has emailed it', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    const first = page.getByRole('table').first().locator('tbody tr').first();
    await expect(first).toContainText('Created by');
    await expect(first).toContainText('Emailed by');
    await expect(first).toContainText('Not emailed yet');
    if (test.info().project.name === 'desktop') {
      await expect(page.getByRole('columnheader', { name: 'Staff' })).toBeVisible();
    }
  });

  test('the quote window shows who made it and who emailed it', async ({ page }) => {
    await gotoAdmin(page, '/admin/quotes', 'Sales Quotes');
    const row = page.getByRole('table').first().locator('tbody tr').first();
    await row.getByRole('button', { name: /^View QTE/ }).click();
    const dialog = page.getByRole('dialog', { name: /^QTE/ });
    await expect(dialog.getByText('Created by', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Emailed to customer by')).toBeVisible();
    await expect(dialog.getByText('Not emailed yet')).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('the quote window is wide, and the customer details are on unless hidden', async ({ page }) => {
    const dialog = await openNewQuote(page);
    const box = await dialog.boundingBox();
    if (test.info().project.name === 'desktop') expect(box?.width ?? 0).toBeGreaterThan(1150);
    const hide = dialog.getByRole('checkbox', { name: /Hide the customer details/ });
    await expect(hide).not.toBeChecked();
    await expect(dialog.getByText('Bill To information')).toBeVisible();
    await hide.check();
    await expect(dialog.getByText('Bill To information')).toBeHidden();
    await hide.uncheck();
    await expect(dialog.getByText('Bill To information')).toBeVisible();
    await noHorizontalScroll(page);
  });
});
