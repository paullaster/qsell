import { describe, expect, it, vi } from 'vitest';

/**
 * A page must hand back its frame at once, whatever its data is doing. Here every action is a
 * promise that never settles: a page that awaits any of them returns a promise (and would hold the
 * whole screen back); a page that follows the rule returns an element straight away.
 */
/** A stand-in for a server-actions module: every function it exports is a promise that never settles. */
const stub = vi.hoisted(() => async (file: string) => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(`${process.cwd()}/src/server/domains/${file}.ts`, 'utf8');
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]);
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const stub: Record<string, () => Promise<never>> = {};
  for (const name of names) stub[name] = never;
  return stub;
});

vi.mock('@/server/domains/finance/actions', () => stub('finance/actions'));
vi.mock('@/server/domains/finance/wallet-actions', () => stub('finance/wallet-actions'));
vi.mock('@/server/domains/finance/receivables/actions', () => stub('finance/receivables/actions'));
vi.mock('@/server/domains/finance/refund-actions', () => stub('finance/refund-actions'));
vi.mock('@/server/domains/finance/refund-file-actions', () => stub('finance/refund-file-actions'));
vi.mock('@/server/domains/finance/credit-adjustment-actions', () => stub('finance/credit-adjustment-actions'));
vi.mock('@/server/domains/finance/inventory-posting-actions', () => stub('finance/inventory-posting-actions'));
vi.mock('@/server/domains/finance/fx-actions', () => stub('finance/fx-actions'));
vi.mock('@/server/domains/finance/credit-note-actions', () => stub('finance/credit-note-actions'));
vi.mock('@/server/domains/finance/bank-statement-actions', () => stub('finance/bank-statement-actions'));
vi.mock('@/server/domains/finance/sales-actions', () => stub('finance/sales-actions'));
vi.mock('@/server/domains/finance/payment-setup-actions', () => stub('finance/payment-setup-actions'));
vi.mock('@/server/domains/payments/activity-actions', () => stub('payments/activity-actions'));
vi.mock('@/server/domains/payments/bill-actions', () => stub('payments/bill-actions'));
vi.mock('@/server/domains/payments/actions', () => stub('payments/actions'));
vi.mock('@/server/domains/returns/actions', () => stub('returns/actions'));
vi.mock('@/server/domains/access-control/guard', () => stub('access-control/guard'));
vi.mock('@/server/domains/lookups/actions', () => stub('lookups/actions'));

const pending = <T,>() => new Promise<T>(() => undefined);

const pages: [string, () => Promise<{ default: (props: never) => unknown }>, Record<string, unknown>][] = [
  ['receipts', () => import('../../../../app/admin/finance/receipts/page'), {}],
  ['new receipt', () => import('../../../../app/admin/finance/receipts/new/page'), { searchParams: pending() }],
  ['receipt', () => import('../../../../app/admin/finance/receipts/[id]/page'), { params: pending(), searchParams: pending() }],
  ['refunds', () => import('../../../../app/admin/finance/refunds/page'), {}],
  ['new refund', () => import('../../../../app/admin/finance/refunds/new/page'), { searchParams: pending() }],
  ['refund', () => import('../../../../app/admin/finance/refunds/[id]/page'), { params: pending() }],
  ['refund payment files', () => import('../../../../app/admin/finance/refunds/files/page'), {}],
  ['refund payment file', () => import('../../../../app/admin/finance/refunds/files/[id]/page'), { params: pending() }],
  ['credit adjustments', () => import('../../../../app/admin/finance/receivables/credit-adjustments/page'), {}],
  ['new credit adjustment', () => import('../../../../app/admin/finance/receivables/credit-adjustments/new/page'), { searchParams: pending() }],
  ['credit adjustment', () => import('../../../../app/admin/finance/receivables/credit-adjustments/[id]/page'), { params: pending() }],
  ['wallet policy', () => import('../../../../app/admin/finance/receivables/wallet-policy/page'), {}],
  ['wallets', () => import('../../../../app/admin/finance/receivables/wallets/page'), {}],
  ['credit note excess', () => import('../../../../app/admin/finance/receivables/credit-note-excess/page'), {}],
  ['customer account', () => import('../../../../app/admin/finance/receivables/customer/[id]/page'), { params: pending() }],
  ['returns', () => import('../../../../app/admin/finance/receivables/returns/page'), {}],
  ['return', () => import('../../../../app/admin/finance/receivables/returns/[id]/page'), { params: pending() }],
  ['chart of accounts', () => import('../../../../app/admin/finance/accounts/page'), {}],
  ['ledger entries', () => import('../../../../app/admin/finance/entries/page'), {}],
  ['journals', () => import('../../../../app/admin/finance/journals/page'), {}],
  ['journal batch', () => import('../../../../app/admin/finance/journals/[id]/page'), { params: pending() }],
  ['fiscal periods', () => import('../../../../app/admin/finance/periods/page'), {}],
  ['posting setup', () => import('../../../../app/admin/finance/posting-setup/page'), {}],
  ['ageing', () => import('../../../../app/admin/finance/receivables/ageing/page'), {}],
  ['registers', () => import('../../../../app/admin/finance/registers/page'), {}],
  ['sales posting', () => import('../../../../app/admin/finance/sales-posting/page'), {}],
  ['exchange rates', () => import('../../../../app/admin/finance/exchange-rates/page'), {}],
  ['stock in the books', () => import('../../../../app/admin/finance/inventory-posting/page'), {}],
  ['trial balance', () => import('../../../../app/admin/finance/trial-balance/page'), {}],
  ['bank accounts', () => import('../../../../app/admin/finance/bank-accounts/page'), {}],
  ['bank statements', () => import('../../../../app/admin/finance/bank-statements/page'), {}],
  ['bank statement', () => import('../../../../app/admin/finance/bank-statements/[accountId]/page'), { params: pending() }],
  ['payment settings', () => import('../../../../app/admin/settings/payments/page'), {}],
  ['payment activity', () => import('../../../../app/admin/payments/activity/page'), {}],
  ['bill manager', () => import('../../../../app/admin/payments/bills/page'), {}],
];

describe('pages do not wait for their data', () => {
  it.each(pages)('%s returns its frame immediately', async (_name, load, props) => {
    const page = (await load()).default;
    const out = page(props as never);
    expect(out instanceof Promise).toBe(false);
    expect(out).toBeTruthy();
  });
});
