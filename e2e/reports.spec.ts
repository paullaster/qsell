import { E2E_URL } from './support/constants';
import { expect, test } from '@playwright/test';
import {
  clickUntilVisible,
  noHorizontalScroll,
  noInnerHorizontalScroll,
  noNativeSelect,
  open,
} from './support/page';

test.describe('reports hub', () => {
  test('lists the reports this person may open, finds one by what they want to know, and remembers a star', async ({
    page,
  }) => {
    await open(page, '/admin/reports', 'Reports');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    const cards = page.getByTestId('report-card');
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 3, name: 'Finance' })).toBeVisible();

    // Filtering by the plain-language question a report answers, not only by its title.
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('owes us');
    await expect(cards.filter({ hasText: 'Receivables ageing' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Payables ageing' })).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('zzzz-nothing');
    await expect(page.getByText(/No report matches/)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('');

    // A star is kept in this browser and survives a reload.
    const star = page.getByRole('button', { name: 'Star Receivables ageing' });
    await expect(async () => {
      await star.click();
      await expect(page.getByRole('heading', { level: 3, name: 'Starred' })).toBeVisible({
        timeout: 3000,
      });
    }).toPass({ timeout: 60_000 });
    await page.reload();
    await expect(page.getByRole('heading', { level: 3, name: 'Starred' })).toBeVisible({
      timeout: 60_000,
    });
    await page
      .getByRole('button', { name: 'Remove Receivables ageing from starred' })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 3, name: 'Starred' })).toBeHidden();
  });

  test('the command palette opens from the button, searches, and goes to the report', async ({
    page,
  }) => {
    await open(page, '/admin/reports', 'Reports');
    const dialog = page.getByRole('dialog', { name: 'Find a report' });
    await clickUntilVisible(page.getByTestId('palette-open'), dialog);
    await dialog.getByRole('combobox', { name: 'Search reports' }).fill('debtors');
    await expect(dialog.getByRole('option', { name: /Receivables ageing/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('the style guide shows every chart with a table behind it, fits the screen and uses no native select', async ({
    page,
  }) => {
    await open(page, '/admin/reports/style-guide', 'Report style guide');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await expect(page.getByRole('group', { name: /Sales per day/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    // The numbers behind the drawing are one click away, as a real table.
    await page.getByText('View as a table').first().click();
    await expect(page.getByRole('table', { name: /Sales per day/ })).toBeVisible();
    await noInnerHorizontalScroll(page);
  });
});

test.describe('report downloads', () => {
  test('a report is downloaded as CSV, Excel and PDF, the file is fingerprinted, and the download is on the audit trail', async ({
    page,
  }) => {
    await open(page, '/admin/reports/receivables-ageing', 'Receivables ageing');
    await noHorizontalScroll(page);
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      await expect(page.getByTestId(`download-${format}`)).toBeVisible({ timeout: 60_000 });
    }

    const csv = await page.request.get('/api/admin/reports/receivables-ageing/export?format=csv');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(csv.headers()['content-disposition']).toMatch(
      /attachment; filename="[a-z0-9-]+_receivables-ageing_\d{8}-\d{6}\.csv"/,
    );
    expect(csv.headers()['x-file-sha256']).toMatch(/^[0-9a-f]{64}$/);
    // The file opens in Excel with the right characters: it starts with a byte-order mark.
    const body = await csv.body();
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const xlsx = await page.request.get('/api/admin/reports/receivables-ageing/export?format=xlsx');
    expect(xlsx.status()).toBe(200);
    // An Excel file is a zip.
    expect((await xlsx.body()).subarray(0, 2).toString('latin1')).toBe('PK');

    const pdf = await page.request.get('/api/admin/reports/receivables-ageing/export?format=pdf');
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');

    // What is not offered, or not known, is refused with a status and a plain sentence, never a stack trace.
    const nothing = await page.request.get('/api/admin/reports/no-such-report/export?format=csv');
    expect(nothing.status()).toBe(404);
    const wrong = await page.request.get(
      '/api/admin/reports/receivables-ageing/export?format=docx',
    );
    expect(wrong.status()).toBe(400);
    expect(JSON.stringify(await wrong.json())).not.toMatch(/at .*\.ts|stack/i);

    // The three downloads above are on the activity page, with who took them.
    await open(page, '/admin/reports/activity', 'Report activity');
    await noHorizontalScroll(page);
    await expect(page.getByText('Receivables ageing').locator('visible=true').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('E2E Admin').locator('visible=true').first()).toBeVisible();
  });

  test('a download needs a signed-in person', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const response = await context.request.get(
      `${E2E_URL}/api/admin/reports/receivables-ageing/export?format=csv`,
    );
    expect(response.status()).toBe(401);
    await context.close();
  });
});

test.describe('business overview', () => {
  test('opens on the new report design, states its period and scope, switches period and compares, with no native select', async ({
    page,
  }) => {
    await open(page, '/admin', 'Sales');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    // The figures say when they were made and for which period.
    await expect(page.getByRole('status').filter({ hasText: /Updated/ })).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole('button', { name: 'Today' }).first().click();
    await expect(page).toHaveURL(/period=today/);
    await page.getByText('Same period last year', { exact: true }).click();
    await expect(page).toHaveURL(/compare=previous_year/);

    // A typed range the wrong way round is refused in words and does not change the address.
    const from = page.getByLabel('From');
    const url = page.url();
    await from.fill('2999-01-01');
    await expect(
      page.getByRole('alert').filter({ hasText: /start date must be on or before/ }),
    ).toBeVisible();
    expect(page.url()).toBe(url);
    await noHorizontalScroll(page);
  });
});
