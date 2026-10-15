import { expect, test } from '@playwright/test';
import { E2E_URL } from './support/constants';

/**
 * The finance actions are slowed (the server honours an `e2e-delay` cookie, only in this test
 * server). A screen must show its own loading state at once, and its access check and its data must
 * be fetched side by side: with both slowed by DELAY, the screen is ready in about DELAY, not twice it.
 */
const DELAY = 3000;

const screens: [string, string, RegExp, string | RegExp][] = [
  ['wallet policy', '/admin/finance/receivables/wallet-policy', /Loading the wallet policy/, 'Wallet policy'],
  ['receipts', '/admin/finance/receipts', /Loading receipts/, 'Customer receipts'],
  ['new refund', '/admin/finance/refunds/new', /Loading the refund form/, 'New refund'],
  ['bank accounts', '/admin/finance/bank-accounts', /Loading bank accounts/, 'Bank and cash accounts'],
  ['returns', '/admin/finance/receivables/returns', /Loading returns/, 'Returns'],
  ['dimensions', '/admin/settings/dimensions', /Loading dimensions/, 'Dimensions'],
  ['number series', '/admin/settings/number-series', /Loading number series/, 'Number series'],
  ['document numbering', '/admin/settings/number-series/bindings', /Loading document numbering/, 'Document numbering'],
  ['branches', '/admin/settings/branches', /Loading branches/, 'Branches'],
  ['approval workflows', '/admin/settings/approvals/workflows', /Loading approval workflows/, 'Approval workflows'],
  ['approvers', '/admin/settings/approvals/approvers', /Loading approvers/, 'Approvers'],
  ['approval switches', '/admin/settings/approvals/switches', /Loading the approval switches/, 'Approval switches'],
  ['approval monitor', '/admin/settings/approvals/monitor', /Loading the approval monitor/, 'Approval monitor'],
  ['company mode', '/admin/settings/tax-compliance/kra-tims-etims/company', /Loading the company mode/, 'Company mode'],
  ['branch modes', '/admin/settings/tax-compliance/kra-tims-etims/branches', /Loading the branch modes/, 'Branch modes'],
  ['eTIMS items', '/admin/settings/tax-compliance/kra-tims-etims/items', /Loading eTIMS items/, 'eTIMS items'],
  ['signing log', '/admin/settings/tax-compliance/kra-tims-etims/signing-log', /Loading the signing log/, 'Signing log'],
  ['tax classification', '/admin/settings/tax-compliance/kra-tims-etims/classification', /Loading tax classification/, 'Tax & compliance management'],
  ['approvals inbox', '/admin/approvals/inbox', /Loading your approvals/, 'Approvals waiting on you'],
  ['my approval requests', '/admin/approvals/requests', /Loading your requests/, 'My requests'],
  ['company profile', '/admin/company/profile', /Loading the company profile/, 'Company profile'],
  ['company appearance', '/admin/company/appearance', /Loading the appearance settings/, 'Appearance'],
  ['company modules', '/admin/company/modules', /Loading the module names/, 'Module names'],
  ['company support', '/admin/company/support', /Loading the support settings/, 'Customer support'],
  ['customers', '/admin/customers', /Loading customers/, 'Customers'],
  ['payment settings', '/admin/settings/payments', /Loading payment settings/, 'Payments'],
];

for (const [name, url, skeleton, heading] of screens) {
  test(`${name} shows its loading state at once and loads in parallel`, async ({ page, context }) => {
    const title = page.getByRole('heading', { name: heading, level: 2 }).first();
    // Visit once without the delay so the development server has built the route, then once more to learn how long
    // this screen takes on this machine right now; only then slow the actions down.
    await page.goto(url);
    await expect(title).toBeVisible({ timeout: 60_000 });
    const timed = Date.now();
    await page.goto(url);
    await expect(title).toBeVisible({ timeout: 60_000 });
    const baseline = Date.now() - timed;
    // The wait has to be longer than the screen's own first draw on this machine, or the loading state could never be told
    // apart from the data arriving.
    const delay = Math.max(DELAY, baseline + 1500);
    await context.addCookies([{ name: 'e2e-delay', value: String(delay), url: E2E_URL }]);
    const started = Date.now();
    await page.goto(url, { waitUntil: 'commit' });
    await expect(page.getByRole('status').filter({ hasText: skeleton })).toBeVisible({ timeout: delay - 500 });
    expect(Date.now() - started).toBeLessThan(delay);
    await expect(title).toBeVisible({ timeout: baseline + delay * 2 + 5000 });
    // Side by side the delays overlap: the screen takes its usual time plus about one delay. Waits one after the other
    // would add a second delay on top.
    expect(Date.now() - started).toBeLessThan(baseline + delay * 1.7);
  });
}
