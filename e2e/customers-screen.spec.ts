import { expect, test, type Page } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect } from './support/page';

async function openCustomers(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto('/admin/customers/list');
    try {
      const title = page.getByRole('heading', { name: 'Customers', level: 2 }).first();
      await expect(title).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          () => title.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))),
          { timeout: 30_000 },
        )
        .toBe(true);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

test.describe('customers screen', () => {
  test('Customers opens a hub with List and Customer groups before the customer list', async ({
    page,
  }) => {
    await page.goto('/admin/customers');
    await expect(page.getByRole('heading', { name: 'Customers', level: 2 })).toBeVisible();
    // The sidebar has the same links; the hub's own are the last on the page.
    await expect(page.getByRole('link', { name: /^List/ }).last()).toHaveAttribute(
      'href',
      '/admin/customers/list',
    );
    await expect(page.getByRole('link', { name: /^Customer groups/ }).last()).toHaveAttribute(
      'href',
      '/admin/pricing/groups',
    );
    // A click before the page has hydrated is lost, so it is repeated until the page has moved.
    await expect(async () => {
      await page.getByRole('link', { name: /^List/ }).last().click();
      await expect(page).toHaveURL(/\/admin\/customers\/list$/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Customers', level: 2 })).toBeVisible();
  });

  test('the customer centre shows a customer statement and drills into each transaction', async ({
    page,
    isMobile,
  }) => {
    await openCustomers(page);
    await page.getByLabel('Search customers').fill('E2E001');
    await page.getByRole('link', { name: 'Open Alice Cash' }).click();
    await expect(page).toHaveURL(/\/admin\/customers\/[^/]+$/);
    await expect(page.getByRole('heading', { name: 'Statement of Account' })).toBeVisible();
    await expect(page.getByLabel('From', { exact: true })).not.toHaveValue('');
    await expect(page.getByLabel('To', { exact: true })).not.toHaveValue('');
    await expect(page.getByText('Closing balance due').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Balance brought forward').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Closing balance').locator('visible=true').first()).toBeVisible();

    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    expect((await pdfDownload).suggestedFilename()).toMatch(/^customer-statement-.*\.pdf$/);
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    expect((await csvDownload).suggestedFilename()).toMatch(/^customer-statement-.*\.csv$/);

    if (!isMobile) {
      await expect(page.getByRole('columnheader', { name: 'Debit' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Credit' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Balance' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Drilldown' })).toHaveCount(0);
    } else {
      await expect(page.getByText('Debit', { exact: true }).locator('visible=true').first()).toBeVisible();
      await expect(page.getByText('Credit', { exact: true }).locator('visible=true').first()).toBeVisible();
      await expect(page.getByText('Balance', { exact: true }).locator('visible=true').first()).toBeVisible();
    }
    await clickUntilVisible(
      page.getByRole('button', { name: /View details for Payment/ }).first(),
      page.getByRole('dialog', { name: /Transaction detail/ }),
    );
    const dialog = page.getByRole('dialog', { name: /Transaction detail/ });
    await expect(page.getByRole('link', { name: /Download receipt/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Print receipt/ })).toBeVisible();
    await expect(dialog.getByText('Document amount', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Related documents' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: /^Open / })).not.toHaveCount(0);
    // What a payment was applied to depends on what the shard has already done: the seeded receipt is left
    // unapplied, so either the table of applications or the plain note that there are none is shown.
    const applications = isMobile
      ? dialog.getByText('Amount applied', { exact: true })
      : dialog.getByRole('columnheader', { name: 'Amount applied' });
    await expect(applications.or(dialog.getByText('Nothing has been applied to this document.'))).toBeVisible();
    if (!isMobile) {
      await expect(dialog.getByRole('columnheader', { name: 'When' })).toBeVisible();
      await expect(dialog.getByRole('columnheader', { name: 'What happened' })).toBeVisible();
      await expect(dialog.getByRole('columnheader', { name: 'Why / by whom' })).toBeVisible();
    } else {
      await expect(dialog.getByText('Why / by whom', { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The seeded customer has an invoice only when an earlier spec of this run has billed her, so the invoice view is
    // checked when there is one; its content is covered by the statement's integration tests.
    if ((await page.getByRole('button', { name: /View details for Invoice/ }).count()) > 0) {
      await clickUntilVisible(
        page.getByRole('button', { name: /View details for Invoice/ }).first(),
        dialog,
      );
      await expect(dialog.getByRole('heading', { name: 'Items sold' })).toBeVisible();
      await expect(dialog.getByText('Tax invoice:', { exact: false })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Open tax invoice PDF' })).toBeVisible();
      await expect(dialog.getByRole('link', { name: /Open source sales order/ })).toBeVisible();
      if (!isMobile) {
        await expect(dialog.getByRole('columnheader', { name: 'Item' })).toBeVisible();
        await expect(dialog.getByRole('columnheader', { name: 'Qty' })).toBeVisible();
        await expect(dialog.getByRole('columnheader', { name: 'Unit price' })).toBeVisible();
        await expect(dialog.getByRole('columnheader', { name: 'Discount' })).toBeVisible();
        await expect(dialog.getByRole('columnheader', { name: 'Line total' })).toBeVisible();
      } else {
        await expect(dialog.getByText('Line total', { exact: true })).toBeVisible();
      }
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await noHorizontalScroll(page);
  });

  test('the list is paged and searched on the server, a customer is made, found, changed and deleted after asking', async ({
    page,
    isMobile,
  }, testInfo) => {
    const stamp = `${testInfo.project.name}${String(Date.now()).slice(-6)}`;
    const name = `E2E Card ${stamp}`;
    await openCustomers(page);
    await noNativeSelect(page);
    // A phone shows the customers as cards, a wider screen as a table with a header row.
    const table = isMobile
      ? page.getByRole('list', { name: 'Customers' })
      : page.getByRole('table', { name: 'Customers' });
    const rows = isMobile ? table.getByRole('listitem') : table.getByRole('row');
    const header = isMobile ? 0 : 1;
    await expect(rows).toHaveCount(25 + header, { timeout: 30_000 }); // one page of 25
    // The button sits at the very bottom of a long phone page; press it from the keyboard, as a keyboard user would.
    const more = page.getByRole('button', { name: 'Show more customers' });
    await expect(async () => {
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(rows.nth(25 + header)).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });

    // Text is searched in the database.
    await page.getByLabel('Search customers').fill('E2E001');
    await expect(rows).toHaveCount(1 + header, { timeout: 30_000 });
    await page.getByLabel('Search customers').fill('no-such-customer-zzz');
    await expect(page.getByText(/No customers match/).locator('visible=true')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel('Search customers').fill('');

    // A new card: the type is a picker, credit terms matter only for credit.
    await page.getByRole('button', { name: 'New customer' }).click();
    const card = page.getByRole('form', { name: 'New customer card' });
    await expect(card).toBeVisible();
    await noNativeSelect(page);
    await card.getByLabel('Name', { exact: true }).fill(name);
    await card.getByLabel('Email').fill(`card-${stamp.toLowerCase()}@example.test`);
    await pick(
      page,
      card.getByRole('combobox', { name: 'Account type' }),
      'Credit',
      /Credit \(pays later\)/,
    );
    await expect(card.getByLabel('Credit limit')).toBeEnabled();
    await card.getByLabel('Credit limit').fill('750');
    await card.getByLabel('Payment terms (days)').fill('14');
    await pick(
      page,
      card.getByRole('combobox', { name: 'Blocked' }),
      'Cannot be invoiced',
      /Cannot be invoiced/,
    );
    await card.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} saved.` })).toBeVisible({
      timeout: 30_000,
    });

    // Found. Open goes to the customer centre; Edit is a separate way into the card.
    await page.getByLabel('Search customers').fill(stamp);
    await expect(rows).toHaveCount(1 + header, { timeout: 30_000 });
    await expect(table.getByRole('link', { name: `Edit ${name}` })).toHaveAttribute(
      'href',
      /\/edit$/,
    );
    await expect(table.getByRole('link', { name: `Record a receipt for ${name}` })).toHaveAttribute(
      'href',
      /\/admin\/finance\/receipts\/new\?customer=/,
    );
    if (!isMobile) {
      await expect(table.getByRole('link', { name: `Open ${name}` })).toHaveAttribute(
        'title',
        'Open customer',
      );
      await expect(table.getByRole('link', { name: `Edit ${name}` })).toHaveAttribute(
        'title',
        'Edit customer',
      );
      await expect(
        table.getByRole('link', { name: `Record a receipt for ${name}` }),
      ).toHaveAttribute('title', 'Record a receipt against this customer');
    }
    await table.getByRole('link', { name: `Open ${name}` }).click();
    await expect(page).toHaveURL(/\/admin\/customers\/[^/]+$/);
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customer list' })).toHaveAttribute(
      'href',
      '/admin/customers/list',
    );
    await expect(page.getByRole('heading', { name: 'Customer information' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Statement and transactions' })).toBeVisible();
    await expect(async () => {
      await page.getByRole('link', { name: 'Edit customer' }).click();
      await expect(page).toHaveURL(/\/admin\/customers\/[^/]+\/edit$/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    const again = page.getByRole('form', { name: 'Customer card' });
    await expect(again.getByLabel('Credit limit')).toHaveValue('750.00', { timeout: 30_000 });
    await expect(again.getByRole('combobox', { name: 'Blocked' })).toHaveValue(/invoiced/i);

    // Back to the list: deleting asks first, and "Keep it" changes nothing.
    await page.goto('/admin/customers/list');
    await page.getByLabel('Search customers').fill(stamp);
    await expect(rows).toHaveCount(1 + header, { timeout: 30_000 });
    await table.getByRole('button', { name: `Delete ${name}` }).click();
    await table.getByRole('button', { name: 'Keep it' }).click();
    await expect(rows).toHaveCount(1 + header);
    await clickUntilVisible(
      table.getByRole('button', { name: `Delete ${name}` }),
      table.getByRole('button', { name: `Confirm: Delete ${name}` }),
    );
    await table.getByRole('button', { name: `Confirm: Delete ${name}` }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} deleted.` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/No customers match/).locator('visible=true')).toBeVisible({
      timeout: 30_000,
    });
    await noHorizontalScroll(page);
  });

  test('profiles: one is made with a picker for its type, found and listed', async ({
    page,
    isMobile,
  }, testInfo) => {
    const code = `EP${testInfo.project.name.slice(0, 1).toUpperCase()}${String(Date.now()).slice(-6)}`;
    await openCustomers(page);
    await clickUntilVisible(
      page.getByRole('tab', { name: 'profiles' }),
      page.getByLabel('Search profiles'),
    );
    await page.getByRole('button', { name: 'New profile' }).click();
    const form = page.getByRole('form', { name: 'New profile' });
    await expect(form).toBeVisible();
    await noNativeSelect(page);
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name', { exact: true }).fill(`Profile ${code}`);
    await pick(
      page,
      form.getByRole('combobox', { name: 'Account type' }),
      'Credit',
      /Credit \(pays later\)/,
    );
    await form.getByLabel('Credit limit').fill('900');
    await form.getByLabel('Payment terms (days)').fill('21');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `Profile ${code} saved.` }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search profiles').fill(code);
    const table = isMobile
      ? page.getByRole('list', { name: 'Customer profiles' })
      : page.getByRole('table', { name: 'Customer profiles' });
    await expect(isMobile ? table.getByRole('listitem') : table.getByRole('row')).toHaveCount(
      isMobile ? 1 : 2,
      { timeout: 30_000 },
    );
    await expect(table.getByText('21 days').first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});
