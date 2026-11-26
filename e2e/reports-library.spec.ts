import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

/** Every report of the first full set, by address and the title it shows. */
const ANALYSES: [string, string][] = [
  ['sales-summary', 'Sales summary'],
  ['sales-by-product', 'Sales by product'],
  ['sales-by-category', 'Sales by category'],
  ['sales-by-vendor', 'Sales by supplier'],
  ['sales-by-branch', 'Sales by branch'],
  ['sales-by-customer', 'Sales by customer'],
  ['sales-by-weekday', 'Sales by weekday'],
  ['sales-by-hour', 'Sales by hour'],
  ['returning-customers', 'Returning customers'],
  ['sales-returns', 'Sales returns'],
  ['gross-margin', 'Gross margin by product'],
  ['money-collected', 'Money collected'],
  ['stock-valuation', 'Stock valuation'],
  ['low-stock', 'Low and out of stock'],
  ['slow-stock', 'Slow and dead stock'],
  ['stock-movement', 'Stock movement'],
];

const STATEMENTS: [string, string][] = [
  ['income-statement', 'Income statement (profit and loss)'],
  ['balance-sheet', 'Balance sheet'],
  ['changes-in-equity', 'Statement of changes in equity'],
  ['cash-flow', 'Cash flow statement'],
];

test.describe('analysis reports', () => {
  for (const [code, title] of ANALYSES) {
    test(`${title} opens, states its figures and fits the screen`, async ({ page }) => {
      test.slow();
      await open(page, `/admin/reports/${code}`, title);
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
      // The figures stream in behind the heading: wait for the headline strip or the empty message.
      await expect(
        page
          .getByRole('region', { name: 'Headline figures' })
          .or(page.getByText(/Nothing recorded|Nothing to list|could not be loaded/))
          .first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText(/could not be loaded just now/)).toHaveCount(0);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
      // Every report says when its figures were made: in the filter bar, or under the title for stock.
      await expect(page.getByText(/Updated|As at/).first()).toBeVisible();
    });
  }

  test('a report can be downloaded, and its file carries a fingerprint', async ({ page }) => {
    await open(page, '/admin/reports/sales-by-product', 'Sales by product');
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      await expect(page.getByTestId(`download-${format}`)).toBeVisible({ timeout: 90_000 });
    }
    const csv = await page.request.get('/api/admin/reports/sales-by-product/export?format=csv');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['x-file-sha256']).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await page.request.get('/api/admin/reports/stock-valuation/export?format=pdf');
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(pdf.headers()['content-disposition']).toMatch(
      /filename="[a-z0-9-]+_stock-valuation_\d{8}-\d{6}\.pdf"/,
    );
  });
});

test.describe('financial statements', () => {
  for (const [code, title] of STATEMENTS) {
    test(`${title} opens, agrees with the books and fits the screen`, async ({
      page,
    }, testInfo) => {
      test.slow();
      await open(page, `/admin/reports/${code}`, title);
      await noNativeSelect(page);
      await expect(page.getByRole('region', { name: 'Checks on this statement' })).toBeVisible({
        timeout: 90_000,
      });
      // A statement that does not agree with the books is a defect, never a normal state.
      await expect(page.getByText('Does not agree:')).toHaveCount(0);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
      // A table from tablet width; cards on a phone.
      if (testInfo.project.name === 'phone') {
        await expect(page.getByTestId('statement-table')).toBeHidden();
        await expect(
          page.getByRole('list', { name: new RegExp(`^${title.split(' (')[0] ?? title}`) }),
        ).toBeVisible();
      } else {
        await expect(page.getByTestId('statement-table')).toBeVisible();
      }
    });
  }

  test('a statement downloads as a file', async ({ page }) => {
    await open(page, '/admin/reports/income-statement', 'Income statement (profit and loss)');
    const xlsx = await page.request.get('/api/admin/reports/income-statement/export?format=xlsx');
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

test.describe('from the Business Overview to the full report', () => {
  test('each panel leads to its report and carries the period with it', async ({ page }) => {
    test.slow();
    await open(page, '/admin?period=this_month&compare=previous_year', 'Sales');
    const link = page.getByRole('link', { name: 'See the full report' }).first();
    await expect(link).toBeVisible({ timeout: 90_000 });
    await expect(link).toHaveAttribute(
      'href',
      /\/admin\/reports\/sales-summary\?.*period=this_month/,
    );
    await expect(link).toHaveAttribute('href', /compare=previous_year/);
    await link.click();
    await expect(page).toHaveURL(/\/admin\/reports\/sales-summary/);
    await expect(page.getByRole('heading', { name: 'Sales summary', level: 2 })).toBeVisible({
      timeout: 90_000,
    });
    // The comparison the person chose is still the one in use.
    await expect(page.getByRole('radio', { name: 'Same period last year' })).toBeChecked();
  });

  test('every panel that has a full report links to it', async ({ page }) => {
    await open(page, '/admin', 'Sales');
    const hrefs = await page
      .getByRole('link', { name: /See the full report|All products|All branches/ })
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    expect(hrefs.join(' ')).toContain('/admin/reports/sales-summary');
    expect(hrefs.join(' ')).toContain('/admin/reports/gross-margin');
    expect(hrefs.join(' ')).toContain('/admin/reports/receivables-ageing');
    expect(hrefs.join(' ')).toContain('/admin/reports/low-stock');
    expect(hrefs.join(' ')).toContain('/admin/reports/money-collected');
  });
});

test.describe('modules', () => {
  test('a module opens the list narrowed to its reports', async ({ page }) => {
    await open(page, '/admin/reports?module=finance', 'Reports');
    const cards = page.getByTestId('report-card');
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    await expect(cards.filter({ hasText: 'Trial balance' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Sales by product' })).toHaveCount(0);
    await page.getByRole('link', { name: 'All reports' }).last().click();
    await expect(cards.filter({ hasText: 'Sales by product' })).toHaveCount(1);
  });

  test('a report that used to live in another module is reached at its report address', async ({
    page,
  }) => {
    const response = await page.goto('/admin/vendors/scorecards');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin\/reports\/vendor-scorecards/);
  });
});

test.describe('getting back', () => {
  test('Back from a report opened from the overview returns to the overview', async ({ page }) => {
    test.slow();
    await open(page, '/admin', 'Sales');
    const link = page.getByRole('link', { name: 'See the full report' }).first();
    await expect(link).toBeVisible({ timeout: 90_000 });
    await link.click();
    await expect(page.getByRole('heading', { name: 'Sales summary', level: 2 })).toBeVisible({
      timeout: 90_000,
    });
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/admin(\?|$)/);
    await expect(page.getByRole('heading', { name: 'Sales', level: 2 }).first()).toBeVisible({
      timeout: 90_000,
    });
  });

  test('Back on a report opened directly goes to the list of reports', async ({ page }) => {
    await page.goto('/admin/reports/stock-valuation');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/admin\/reports$/);
  });
});

test.describe('the hub lists the new reports', () => {
  test('finds a report by the question a person asks', async ({ page }) => {
    await open(page, '/admin/reports', 'Reports');
    const cards = page.getByTestId('report-card');
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    // The overview is the home screen, so it is not offered as a report.
    await expect(cards.filter({ hasText: 'Business overview' })).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('profit and loss');
    await expect(cards.filter({ hasText: 'Income statement' })).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('best selling');
    await expect(cards.filter({ hasText: 'Sales by product' })).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Filter this list' }).fill('retained earnings');
    await expect(cards.filter({ hasText: 'Statement of changes in equity' })).toHaveCount(1);
  });
});
