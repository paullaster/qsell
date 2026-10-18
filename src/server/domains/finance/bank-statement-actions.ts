'use server';

import { getContainer } from '@/server/di/container';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import type { LookupResult } from '@/lib/lookup';
import { pageHeaders } from '@/lib/statement-import-form';
import { postingPermissions, run } from './action-runner';
import type { CsvMapping } from './domain/bank-statement';
import { FinanceError } from './errors';
import type { StatementLineStatus } from '@/server/db/drizzle/schema';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/bank-statements';

export async function bankStatementsOverviewAction() {
  return await run('bank_statements:read', { surface: 'finance/bank-statements', action: 'overview' }, async (ctx) => {
    const rows = await fin().bankStatements.overview(ctx.companyId);
    return { rows, can: { import: await canPermission('bank_statements:import') } };
  });
}

export async function savedStatementFormatAction(bankAccountId: string) {
  return await run('bank_statements:import', { surface: 'finance/bank-statements/account', action: 'saved_format' }, async (ctx) => {
    const f = await fin().bankStatements.getFormat(ctx.companyId, bankAccountId);
    return f ? { kind: f.kind, mapping: f.mapping as unknown as CsvMapping } : null;
  });
}

export async function runAutoMatchAction(bankAccountId: string) {
  return await run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'auto_match' }, async (ctx) => await fin().bankStatements.autoMatch(ctx, bankAccountId), [ROOT, `${ROOT}/${bankAccountId}`]);
}

export async function statementWorkbenchAction(bankAccountId: string, filter: { status?: StatementLineStatus | 'open'; before?: number } = {}) {
  return await run('bank_statements:read', { surface: 'finance/bank-statements/account', action: 'view' }, async (ctx) => {
    const w = await fin().bankStatements.workbench(ctx.companyId, bankAccountId, filter);
    const [methods, recs, preview, chargeGls] = await Promise.all([
      fin().bankStatements.receiptMethods(ctx.companyId, bankAccountId),
      fin().bankReconciliation.list(ctx.companyId, bankAccountId),
      fin().bankReconciliation.preview(ctx.companyId, bankAccountId, new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })),
      fin().bankStatements.chargeGlChoices(ctx.companyId, bankAccountId),
    ]);
    const entry = (e: { id: number; postingDate: string; documentType: string; documentNo: string; description: string | null; amount: string }) => ({ id: e.id, date: e.postingDate, type: e.documentType, no: e.documentNo, description: e.description ?? '', amount: e.amount });
    return {
      account: { id: w.account.id, code: w.account.code, name: w.account.name, kind: w.account.kind, currency: w.account.currency, hasFeeAccount: Boolean(w.account.feeGlAccountId) },
      lines: w.lines.map((l) => ({
        id: l.id, date: l.lineDate, description: l.description, reference: l.reference, counterparty: l.counterparty, amount: l.amount, balance: l.balance,
        status: l.status, rule: l.matchRule, ignoreReason: l.ignoreReason, reconciled: l.reconciliationId !== null,
        proposals: l.proposedEntryIds.map((id) => w.proposed.get(id)).filter((e): e is NonNullable<typeof e> => Boolean(e)).map(entry),
        matches: (w.matched.get(l.id) ?? []).map((m) => ({ entryId: m.entryId, no: m.documentNo, type: m.documentType, description: m.description ?? '', amount: m.amount, rule: m.rule })),
      })),
      nextAfter: w.nextAfter,
      outstanding: w.outstanding.map(entry),
      outstandingCount: w.outstandingCount,
      outstandingNet: (w.outstandingNet / 100).toFixed(2),
      counts: w.counts,
      imports: w.imports.map((i) => ({ id: i.id, fileName: i.fileName, lines: i.lineCount, from: i.dateFrom, to: i.dateTo, in: i.totalIn, out: i.totalOut, at: i.createdAt.toISOString() })),
      bookBalance: w.bookBalance,
      hasFormat: Boolean(w.format),
      // How many there are, to know which buttons to offer; the lists themselves are searched on demand.
      methodCount: methods.length,
      chargeGlCount: chargeGls.length,
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
  return await run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'candidates' }, async (ctx) => {
    const rows = await fin().bankStatements.candidateEntries(ctx.companyId, bankAccountId, { amount, date });
    return rows.map((e) => ({ id: e.id, date: e.postingDate, type: e.documentType, no: e.documentNo, description: e.description ?? '', amount: e.amount }));
  });
}

export async function matchStatementLineAction(bankAccountId: string, lineId: number, entryIds: number[]) {
  return await run('bank_statements:match', { surface: 'finance/bank-statements/account', action: 'match_line' }, async (ctx) => await fin().bankStatements.matchLine(ctx, lineId, entryIds), [`${ROOT}/${bankAccountId}`]);
}

export async function unmatchStatementLineAction(bankAccountId: string, lineId: number, reason: { code: string; text?: string }) {
  return await run('bank_statements:unmatch', { surface: 'finance/bank-statements/account', action: 'unmatch_line' }, async (ctx) => await fin().bankStatements.unmatchLine(ctx, lineId, reason), [`${ROOT}/${bankAccountId}`]);
}

export async function ignoreStatementLineAction(bankAccountId: string, lineId: number, reason: { code: string; text?: string }) {
  return await run('bank_statements:ignore', { surface: 'finance/bank-statements/account', action: 'ignore_line' }, async (ctx) => await fin().bankStatements.ignoreLine(ctx, lineId, reason), [`${ROOT}/${bankAccountId}`]);
}

export async function restoreStatementLineAction(bankAccountId: string, lineId: number) {
  return await run('bank_statements:ignore', { surface: 'finance/bank-statements/account', action: 'restore_line' }, async (ctx) => await fin().bankStatements.restoreLine(ctx, lineId), [`${ROOT}/${bankAccountId}`]);
}

export async function receiptFromStatementLineAction(bankAccountId: string, lineId: number, input: { customerId: string; paymentMethodId: string; allocate?: 'oldest_first' | 'none' }) {
  return await run('bank_statements:create_receipt', { surface: 'finance/bank-statements/account', action: 'create_receipt' }, async (ctx) => {
    if (!(await canPermission('receipts:create'))) throw new FinanceError('CANNOT_CREATE_RECEIPT', 'Creating a receipt also needs the permission to create receipts.');
    return await fin().bankStatements.createReceiptFromLine(ctx, lineId, { ...input, permissions: await postingPermissions() });
  }, [`${ROOT}/${bankAccountId}`, '/admin/finance/receipts']);
}

export async function chargeFromStatementLineAction(bankAccountId: string, lineId: number, glAccountId?: string) {
  return await run('bank_statements:record_charge', { surface: 'finance/bank-statements/account', action: 'record_charge' }, async (ctx) => await fin().bankStatements.recordChargeFromLine(ctx, lineId, { glAccountId, permissions: await postingPermissions() }), [`${ROOT}/${bankAccountId}`]);
}

export async function reconciliationPreviewAction(bankAccountId: string, statementDate: string) {
  return await run('bank_statements:read', { surface: 'finance/bank-statements/account', action: 'reconcile_preview' }, async (ctx) => await fin().bankReconciliation.preview(ctx.companyId, bankAccountId, statementDate));
}

export async function postBankReconciliationAction(input: { bankAccountId: string; statementDate: string; statementBalance: string; openingBalance?: string; notes?: string }) {
  return await run('bank_reconciliation:post', { surface: 'finance/bank-statements/account', action: 'post_reconciliation' }, async (ctx) => await fin().bankReconciliation.post(ctx, input), [ROOT, `${ROOT}/${input.bankAccountId}`]);
}

export async function reverseBankReconciliationAction(bankAccountId: string, id: string, reason: { code: string; text?: string }) {
  return await run('bank_reconciliation:reverse', { surface: 'finance/bank-statements/account', action: 'reverse_reconciliation' }, async (ctx) => await fin().bankReconciliation.reverse(ctx, id, reason), [ROOT, `${ROOT}/${bankAccountId}`]);
}

export async function searchCustomersForStatementAction(q: string) {
  return await run('bank_statements:create_receipt', { surface: 'finance/bank-statements/account', action: 'search_customers' }, async (ctx) => await fin().receipts.searchCustomers(ctx.companyId, q));
}

/**
 * Searches the column names of the file being imported. The names are in the browser (it just
 * chose the file), so they are sent along, capped and cleaned, and the search runs here like any
 * other list's.
 */
export async function searchStatementColumnsAction(input: { headers: string[]; query: string; cursor: string | null; limit: number }): Promise<LookupResult> {
  try {
    await requirePermission('bank_statements:import');
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to see this list.' };
    return { ok: false, error: 'Could not load the list. Try again.' };
  }
  const headers = Array.isArray(input.headers) ? input.headers.filter((h): h is string => typeof h === 'string') : [];
  const query = typeof input.query === 'string' ? input.query : '';
  const cursor = typeof input.cursor === 'string' ? input.cursor : null;
  return { ok: true, data: pageHeaders(headers, query, cursor, Number.isFinite(input.limit) ? input.limit : 20) };
}

/** How lines on this account's statement are matched, and which rules are in force (its own, the company's, or the standard ones). */
export async function bankMatchRulesAction(bankAccountId: string) {
  return await run('bank_statements:read', { surface: 'finance/bank-statements/account', action: 'rules' }, async (ctx) => {
    const { rules, scope } = await fin().bankStatements.rulesFor(ctx.companyId, bankAccountId);
    return { rules, scope, canEdit: await canPermission('bank_match_rules:edit') };
  });
}

/** Saves the rules for one account, or (with no account) for every account that has none of its own, and matches again. */
export async function saveBankMatchRulesAction(bankAccountId: string | null, rules: Record<string, unknown>) {
  return await run('bank_match_rules:edit', { surface: 'finance/bank-statements/account', action: 'save_rules' }, async (ctx) => {
    const saved = await fin().bankStatements.saveRules(ctx, bankAccountId, rules);
    const matched = bankAccountId === null ? null : await fin().bankStatements.autoMatch(ctx, bankAccountId);
    return { rules: saved, matched };
  }, [ROOT, ...(bankAccountId === null ? [] : [`${ROOT}/${bankAccountId}`])]);
}

export async function bankFeedStatusAction(bankAccountId: string) {
  return await run('bank_feeds:read', { surface: 'finance/bank-statements/account', action: 'feed' }, async (ctx) => {
    const status = await fin().bankFeeds.status(ctx.companyId, bankAccountId);
    return { status: status === null ? null : { ...status, createdAt: status.createdAt.toISOString(), rotatedAt: status.rotatedAt?.toISOString() ?? null, lastReceivedAt: status.lastReceivedAt?.toISOString() ?? null }, canManage: await canPermission('bank_feeds:manage') };
  });
}

/** Makes the feed, or gives it a new secret (the old address stops working). The address is shown this once. */
export async function enableBankFeedAction(bankAccountId: string) {
  return await run('bank_feeds:manage', { surface: 'finance/bank-statements/account', action: 'enable_feed' }, async (ctx) => {
    const { secret } = await fin().bankFeeds.enable(ctx, bankAccountId);
    const company = await getContainer().companySettings.ensureSeeded();
    const h = await (await import('next/headers')).headers();
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
    const base = (company.publicBaseUrl ?? '').replace(/\/+$/, '') !== '' ? (company.publicBaseUrl ?? '').replace(/\/+$/, '') : `${proto}://${host}`;
    return { address: `${base}/api/hooks/bank-feed/${bankAccountId}/${secret}` };
  }, [`${ROOT}/${bankAccountId}`]);
}

export async function disableBankFeedAction(bankAccountId: string) {
  return await run('bank_feeds:manage', { surface: 'finance/bank-statements/account', action: 'disable_feed' }, async (ctx) => {
    await fin().bankFeeds.disable(ctx, bankAccountId);
    return { ok: true };
  }, [`${ROOT}/${bankAccountId}`]);
}
