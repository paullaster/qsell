'use server';

import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { postingPermissions, run } from './action-runner';
import type { CsvMapping } from './domain/bank-statement';
import { FinanceError } from './errors';
import type { StatementLineStatus } from '@/server/db/drizzle/schema';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/bank-statements';
const reasonList = async (companyId: string) => (await getContainer().reasonCodes.list(companyId)).filter((r) => r.isActive).map((r) => ({ code: r.code, description: r.description, requiresComment: r.requiresComment }));

export async function bankStatementsOverviewAction() {
  return run('bank_statements:read', { surface: 'finance/bank-statements', action: 'overview' }, async (ctx) => {
    const rows = await fin().bankStatements.overview(ctx.companyId);
    return { rows, can: { import: await canPermission('bank_statements:import') } };
  });
}

export async function savedStatementFormatAction(bankAccountId: string) {
  return run('bank_statements:import', { surface: 'finance/bank-statements/account', action: 'saved_format' }, async (ctx) => {
    const f = await fin().bankStatements.getFormat(ctx.companyId, bankAccountId);
    return f ? { kind: f.kind, mapping: f.mapping as unknown as CsvMapping } : null;
  });
}

export async function runAutoMatchAction(bankAccountId: string) {
  return run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'auto_match' }, async (ctx) => fin().bankStatements.autoMatch(ctx, bankAccountId), [ROOT, `${ROOT}/${bankAccountId}`]);
}

export async function statementWorkbenchAction(bankAccountId: string, filter: { status?: StatementLineStatus | 'open'; before?: number } = {}) {
  return run('bank_statements:read', { surface: 'finance/bank-statements/account', action: 'view' }, async (ctx) => {
    const w = await fin().bankStatements.workbench(ctx.companyId, bankAccountId, filter);
    const [methods, reasons, recs, preview] = await Promise.all([
      fin().bankStatements.receiptMethods(ctx.companyId, bankAccountId),
      reasonList(ctx.companyId),
      fin().bankReconciliation.list(ctx.companyId, bankAccountId),
      fin().bankReconciliation.preview(ctx.companyId, bankAccountId, new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })),
    ]);
    const entry = (e: { id: number; postingDate: string; documentType: string; documentNo: string; description: string | null; amount: string }) => ({ id: e.id, date: e.postingDate, type: e.documentType, no: e.documentNo, description: e.description ?? '', amount: e.amount });
    return {
      account: { id: w.account.id, code: w.account.code, name: w.account.name, kind: w.account.kind, currency: w.account.currency, hasFeeAccount: !!w.account.feeGlAccountId },
      lines: w.lines.map((l) => ({
        id: l.id, date: l.lineDate, description: l.description, reference: l.reference, counterparty: l.counterparty, amount: l.amount, balance: l.balance,
        status: l.status, rule: l.matchRule, ignoreReason: l.ignoreReason, reconciled: l.reconciliationId !== null,
        proposals: l.proposedEntryIds.map((id) => w.proposed.get(id)).filter((e): e is NonNullable<typeof e> => !!e).map(entry),
        matches: (w.matched.get(l.id) ?? []).map((m) => ({ entryId: m.entryId, no: m.documentNo, type: m.documentType, description: m.description ?? '', amount: m.amount, rule: m.rule })),
      })),
      nextAfter: w.nextAfter,
      outstanding: w.outstanding.map(entry),
      outstandingCount: w.outstandingCount,
      outstandingNet: (w.outstandingNet / 100).toFixed(2),
      counts: w.counts,
      imports: w.imports.map((i) => ({ id: i.id, fileName: i.fileName, lines: i.lineCount, from: i.dateFrom, to: i.dateTo, in: i.totalIn, out: i.totalOut, at: i.createdAt.toISOString() })),
      bookBalance: w.bookBalance,
      hasFormat: !!w.format,
      methods,
      reasons,
      reconciliations: recs.map((r) => ({ id: r.id, number: r.number, date: r.statementDate, balance: r.statementBalance, lines: r.lineCount, status: r.status, at: r.postedAt.toISOString() })),
      preview,
      can: {
        import: await canPermission('bank_statements:import'),
        match: await canPermission('bank_statements:match'),
        unmatch: await canPermission('bank_statements:unmatch'),
        ignore: await canPermission('bank_statements:ignore'),
        createReceipt: (await canPermission('bank_statements:create_receipt')) && (await canPermission('receipts:create')),
        recordCharge: await canPermission('bank_statements:record_charge'),
        reconcile: await canPermission('bank_reconciliation:post'),
        reverse: await canPermission('bank_reconciliation:reverse'),
      },
    };
  });
}

export async function candidateEntriesAction(bankAccountId: string, amount: string, date: string) {
  return run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'candidates' }, async (ctx) => {
    const rows = await fin().bankStatements.candidateEntries(ctx.companyId, bankAccountId, { amount, date });
    return rows.map((e) => ({ id: e.id, date: e.postingDate, type: e.documentType, no: e.documentNo, description: e.description ?? '', amount: e.amount }));
  });
}

export async function matchStatementLineAction(bankAccountId: string, lineId: number, entryIds: number[]) {
  return run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'match_line' }, async (ctx) => fin().bankStatements.matchLine(ctx, lineId, entryIds), [`${ROOT}/${bankAccountId}`]);
}

export async function unmatchStatementLineAction(bankAccountId: string, lineId: number, reason: { code: string; text?: string }) {
  return run('bank_statements:unmatch', { surface: 'finance/bank-statements/account', action: 'unmatch_line' }, async (ctx) => fin().bankStatements.unmatchLine(ctx, lineId, reason), [`${ROOT}/${bankAccountId}`]);
}

export async function ignoreStatementLineAction(bankAccountId: string, lineId: number, reason: { code: string; text?: string }) {
  return run('bank_statements:ignore', { surface: 'finance/bank-statements/account', action: 'ignore_line' }, async (ctx) => fin().bankStatements.ignoreLine(ctx, lineId, reason), [`${ROOT}/${bankAccountId}`]);
}

export async function restoreStatementLineAction(bankAccountId: string, lineId: number) {
  return run('bank_statements:ignore', { surface: 'finance/bank-statements/account', action: 'restore_line' }, async (ctx) => fin().bankStatements.restoreLine(ctx, lineId), [`${ROOT}/${bankAccountId}`]);
}

export async function receiptFromStatementLineAction(bankAccountId: string, lineId: number, input: { customerId: string; paymentMethodId: string; allocate?: 'oldest_first' | 'none' }) {
  return run('bank_statements:create_receipt', { surface: 'finance/bank-statements/account', action: 'create_receipt' }, async (ctx) => {
    if (!(await canPermission('receipts:create'))) throw new FinanceError('CANNOT_CREATE_RECEIPT', 'Creating a receipt also needs the permission to create receipts.');
    return fin().bankStatements.createReceiptFromLine(ctx, lineId, { ...input, permissions: await postingPermissions() });
  }, [`${ROOT}/${bankAccountId}`, '/admin/finance/receipts']);
}

export async function chargeFromStatementLineAction(bankAccountId: string, lineId: number) {
  return run('bank_statements:record_charge', { surface: 'finance/bank-statements/account', action: 'record_charge' }, async (ctx) => fin().bankStatements.recordChargeFromLine(ctx, lineId, await postingPermissions()), [`${ROOT}/${bankAccountId}`]);
}

export async function reconciliationPreviewAction(bankAccountId: string, statementDate: string) {
  return run('bank_statements:read', { surface: 'finance/bank-statements/account', action: 'reconcile_preview' }, async (ctx) => fin().bankReconciliation.preview(ctx.companyId, bankAccountId, statementDate));
}

export async function postBankReconciliationAction(input: { bankAccountId: string; statementDate: string; statementBalance: string; openingBalance?: string; notes?: string }) {
  return run('bank_reconciliation:post', { surface: 'finance/bank-statements/account', action: 'post_reconciliation' }, async (ctx) => fin().bankReconciliation.post(ctx, input), [ROOT, `${ROOT}/${input.bankAccountId}`]);
}

export async function reverseBankReconciliationAction(bankAccountId: string, id: string, reason: { code: string; text?: string }) {
  return run('bank_reconciliation:reverse', { surface: 'finance/bank-statements/account', action: 'reverse_reconciliation' }, async (ctx) => fin().bankReconciliation.reverse(ctx, id, reason), [ROOT, `${ROOT}/${bankAccountId}`]);
}

export async function searchCustomersForStatementAction(q: string) {
  return run('bank_statements:create_receipt', { surface: 'finance/bank-statements/account', action: 'search_customers' }, async (ctx) => fin().receipts.searchCustomers(ctx.companyId, q));
}
