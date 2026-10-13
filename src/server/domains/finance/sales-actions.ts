'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from './action-runner';
import { fromCents } from './domain/receivables';

const fin = () => getContainer().finance;
const PATH = '/admin/finance/sales-posting';

export async function salesPostingOverviewAction() {
  return run('sales_posting:read', { surface: 'finance/sales-posting', action: 'view' }, async (ctx) => {
    const [settings, checks, backlog, open, recon, accounts, openingFigures] = await Promise.all([
      fin().setup.getSettings(ctx.companyId),
      fin().salesPosting.readiness(ctx.companyId),
      fin().salesPosting.backlog(ctx.companyId),
      fin().salesPosting.list(ctx.companyId, 'open'),
      fin().salesPosting.reconciliation(ctx.companyId),
      fin().setup.listAccounts(ctx.companyId),
      fin().salesPosting.openingFigures(ctx.companyId),
    ]);
    const postable = accounts.filter((a) => a.type === 'posting' && !a.blocked);
    return {
      goLive: settings?.salesGlGoLive ?? null,
      outputTaxAccountId: settings?.outputTaxAccountId ?? null,
      baseCurrency: settings?.baseCurrency ?? '',
      checks,
      backlog,
      open: open.map((r) => ({
        id: r.id,
        kind: r.kind,
        subjectId: r.subjectId,
        eventDate: r.eventDate,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        createdAt: r.createdAt.toISOString(),
      })),
      reconciliation: recon.rows.map((r) => ({
        accountNo: r.accountNo,
        accountName: r.accountName,
        gl: fromCents(r.glCents),
        subLedger: fromCents(r.subLedgerCents),
        diff: fromCents(r.diffCents),
        foreignEntries: r.foreignEntries,
      })),
      opening: openingFigures.filter((f) => f.netCents !== 0).map((f) => ({ group: f.group, amount: fromCents(f.netCents), foreignEntries: f.foreignEntries })),
      liabilityAccounts: postable.filter((a) => a.category === 'liabilities').map((a) => ({ id: a.id, label: `${a.no} ${a.name}` })),
      equityAccounts: postable.filter((a) => a.category === 'equity').map((a) => ({ id: a.id, label: `${a.no} ${a.name}` })),
      can: {
        setTax: await canPermission('finance_settings:edit'),
        goLive: await canPermission('sales_gl_go_live:set'),
        retry: await canPermission('sales_posting:retry'),
      },
    };
  });
}

export async function setOutputTaxAccountAction(accountId: string) {
  return run('finance_settings:edit', { surface: 'finance/sales-posting', action: 'set_output_tax_account' }, async (ctx) =>
    fin().salesPosting.setOutputTaxAccount(ctx, accountId), [PATH]);
}

export async function goLiveAction(offsetAccountId: string) {
  return run('sales_gl_go_live:set', { surface: 'finance/sales-posting', action: 'go_live' }, async (ctx) =>
    fin().salesPosting.goLive(ctx, { offsetAccountId }), [PATH, '/admin/finance/receipts']);
}

export async function retrySalesPostingAction(id?: string) {
  return run('sales_posting:retry', { surface: 'finance/sales-posting', action: id ? 'retry_one' : 'retry_all' }, async (ctx) =>
    fin().salesPosting.retry(ctx, id), [PATH]);
}
