import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import {
  clickUntilVisible,
  noHorizontalScroll,
  noInnerHorizontalScroll,
  noNativeSelect,
  open,
} from './support/page';

test.describe('cash counts', () => {
  test('a drawer is counted note by note: it agrees, then it is short and the difference is explained', async ({
    page,
  }, testInfo) => {
    const code = `E2EDRAWER-${testInfo.project.name === 'phone' ? 'PHONE' : 'DESKTOP'}`;
    await open(page, '/admin/finance/cash-counts', 'Cash counts');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const card = page.getByRole('region', { name: new RegExp(code) });
    await expect(card).toContainText(/Books today: KES [\d,]+\.\d\d/, { timeout: 30_000 });
    // (a retry meets the drawer as the first attempt left it, so the books' figure is read, not assumed)
    const books = Number(
      ((await card.getByText(/Books today/).textContent()) ?? '').replace(/[^\d.]/g, ''),
    );
    expect(books % 100).toBe(0);
    expect(books).toBeGreaterThanOrEqual(400);

    const form = card.getByRole('form', { name: `Count ${code}` });
    await clickUntilVisible(card.getByRole('button', { name: 'Count the cash' }), form);
    await expect(form).toContainText('Books on');

    // A value that makes no sense is said so in words, and nothing can be recorded.
    await form.getByRole('group', { name: 'Row 1' }).getByLabel('Value of one').fill('0');
    await form.getByRole('group', { name: 'Row 1' }).getByLabel('How many').fill('1');
    await expect(
      form.getByText(/Row 1: the value of one note or coin must be more than zero/),
    ).toBeVisible();
    await expect(form.getByRole('button', { name: 'Record the count' })).toBeDisabled();

    // Notes of 500 and 100 that make exactly what the books say: it agrees.
    const fives = Math.floor(books / 500);
    const hundreds = (books - fives * 500) / 100;
    await form.getByRole('group', { name: 'Row 1' }).getByLabel('Value of one').fill('500');
    await form.getByRole('group', { name: 'Row 1' }).getByLabel('How many').fill(String(fives));
    await form.getByRole('button', { name: 'Add a kind of note or coin' }).click();
    await form.getByRole('group', { name: 'Row 2' }).getByLabel('Value of one').fill('100');
    await form.getByRole('group', { name: 'Row 2' }).getByLabel('How many').fill(String(hundreds));
    await expect(form).toContainText(
      `Counted: KES ${books.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    );
    await expect(form).toContainText('The cash agrees with the books.');
    await form.getByRole('button', { name: 'Record the count' }).click();
    await expect(page.getByText(/Counted: CCT-.*The cash agrees with the books\./)).toBeVisible({
      timeout: 30_000,
    });
    await expect(card).toContainText(/Last counted .*agreed/, { timeout: 30_000 });

    // Count again, 300 short of the books, which needs an account and a reason.
    await clickUntilVisible(card.getByRole('button', { name: 'Count the cash' }), form);
    await form.getByRole('button', { name: 'Just the total' }).click();
    await form.getByLabel('Total counted').fill(String(books - 300));
    await expect(form).toContainText('Short by 300.00.');
    await expect(form.getByRole('button', { name: 'Record the count' })).toBeDisabled();
    await pick(page, form.getByRole('combobox', { name: 'Write the difference to' }), '', /./);
    await form.getByLabel('Why does it not agree?').fill('Change given out wrongly');
    await expect(form.getByRole('button', { name: 'Record the count' })).toBeEnabled();
    await form.getByRole('button', { name: 'Record the count' }).click();
    await expect(page.getByText(/Counted: CCT-.*Short by 300\.00\./)).toBeVisible({
      timeout: 30_000,
    });
    await expect(card).toContainText(
      `KES ${(books - 300).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      { timeout: 30_000 },
    );

    // Earlier counts are kept, newest first.
    await card.getByRole('button', { name: 'Earlier counts' }).click();
    // Cards on a phone, a table from md: either way the counts are listed with their reasons.
    await expect(
      card.getByText('Change given out wrongly').filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/CCT-/).filter({ visible: true })).not.toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
