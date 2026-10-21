'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { postingPermissions, run } from './action-runner';
import { fromCents } from './domain/receivables';
import type { DenominationInput } from '@/lib/cash-count';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/cash-counts';

/** The cash accounts, what the books say each holds today, and the last count of each. */
export async function cashCountsOverviewAction() {
  return await run('cash_counts:read', { surface: 'finance/cash-counts', action: 'view' }, async (ctx) => {
    const rows = await fin().cashCounts.overview(ctx.companyId);
    return {
      today: businessDate(),
      canCount: await canPermission('cash_counts:post'),
      accounts: rows.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        currency: a.currency,
        book: fromCents(a.bookCents),
        last: a.last === null ? null : { number: a.last.number, date: a.last.countDate, counted: a.last.countedAmount, difference: a.last.difference },
      })),
    };
  });
}

/** What a count would be measured against on a day, before anything is recorded. */
export async function cashCountPreviewAction(bankAccountId: string, date: string) {
  return await run('cash_counts:post', { surface: 'finance/cash-counts', action: 'preview' }, async (ctx) => {
    const p = await fin().cashCounts.preview(ctx.companyId, bankAccountId, date);
    return { currency: p.currency, book: fromCents(p.bookCents), bookCents: p.bookCents, lastVariance: p.lastVariance, glChoiceCount: p.glChoiceCount };
  });
}

export async function postCashCountAction(input: { bankAccountId: string; countDate: string; denominations?: DenominationInput[]; total?: string; varianceGlAccountId?: string; glAccountId?: string; note?: string }) {
  return await run('cash_counts:post', { surface: 'finance/cash-counts', action: 'post' }, async (ctx) => await fin().cashCounts.post(ctx, { ...input, permissions: await postingPermissions() }), [ROOT, '/admin/finance/bank-accounts']);
}

export async function cashCountHistoryAction(bankAccountId: string, before?: string) {
  return await run('cash_counts:read', { surface: 'finance/cash-counts', action: 'history' }, async (ctx) => {
    const page = await fin().cashCounts.list(ctx.companyId, bankAccountId, before);
    return {
      next: page.next,
      rows: page.rows.map((r) => ({ id: r.id, number: r.number, date: r.countDate, counted: r.countedAmount, expected: r.expectedAmount, difference: r.difference, note: r.note, by: r.countedBy, at: r.createdAt.toISOString() })),
    };
  });
}
