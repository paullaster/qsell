'use server';

import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';

import { canPermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { CHART_TEMPLATES } from './domain/templates';
import type { CalendarShape } from './domain/periods';
import type { GeneralPurpose } from './domain/setup';
import type { PeriodStatus } from './domain/types';
import { run, postingPermissions, type FinanceResult } from './action-runner';
import { FinanceError } from './errors';
import type { AccountInput } from './setup-service';
import type { LineInput } from './journal-service';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance';

// ── setup and chart of accounts ──────────────────────────────────────────

export async function financeOverviewAction() {
  return run('gl_accounts:read', { surface: 'finance/overview', action: 'view' }, async (ctx) => {
    const [settings, years] = await Promise.all([
      fin().setup.getSettings(ctx.companyId),
      fin().fiscal.listYears(ctx.companyId),
    ]);
    return {
      setUp: settings !== null,
      baseCurrency: settings?.baseCurrency ?? null,
      chartTemplate: settings?.chartTemplate ?? null,
      postingFrom: settings?.postingFrom ?? null,
      postingTo: settings?.postingTo ?? null,
      fiscalYears: years.length,
      templates: CHART_TEMPLATES.map((t) => ({
        code: t.code,
        name: t.name,
        description: t.description,
        baseCurrency: t.baseCurrency,
        accounts: t.accounts.length,
      })),
      can: {
        applyTemplate: await canPermission('gl_templates:apply'),
        editAccounts: await canPermission('gl_accounts:edit'),
        createAccounts: await canPermission('gl_accounts:create'),
        blockAccounts: await canPermission('gl_accounts:block'),
        deleteAccounts: await canPermission('gl_accounts:delete'),
        editSettings: await canPermission('finance_settings:edit'),
      },
    };
  });
}

export async function applyTemplateAction(code: string, fiscalYearStart?: string) {
  return run(
    'gl_templates:apply',
    { surface: 'finance/setup', action: 'apply_template' },
    (ctx) => fin().setup.applyTemplate(ctx, code, has(fiscalYearStart) ? { fiscalYearStart } : {}),
    [ROOT],
  );
}

export async function updateFinanceSettingsAction(input: { postingFrom: string | null; postingTo: string | null }) {
  return run(
    'finance_settings:edit',
    { surface: 'finance/setup', action: 'change_posting_window' },
    (ctx) => fin().setup.updateSettings(ctx, input),
    [ROOT],
  );
}

/** One page of the chart, in account-number order, optionally narrowed by text. */
export async function listAccountsPageAction(input: { query?: string; cursor?: string | null }) {
  return await run('gl_accounts:read', { surface: 'finance/chart-of-accounts', action: 'list' }, async (ctx) => {
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const page = await fin().setup.accountsPage(ctx.companyId, { query: typeof input.query === 'string' ? input.query.slice(0, 100) : '', after });
    return {
      rows: page.rows.map((a) => ({
        id: a.id,
        no: a.no,
        name: a.name,
        type: a.type,
        category: a.category,
        normalBalance: a.normalBalance,
        directPosting: a.directPosting,
        postingSource: a.postingSource,
        blocked: a.blocked,
        currencyPolicy: a.currencyPolicy,
        dimensionRule: a.dimensionRule,
        totaling: a.totaling,
        indent: a.indent,
        used: a.usedAt !== null,
      })),
      nextCursor: page.next === null ? null : encodeCursor(page.next),
    };
  });
}
export type AccountView = Extract<Awaited<ReturnType<typeof listAccountsPageAction>>, { ok: true }>['data']['rows'][number];

export async function createAccountAction(input: AccountInput) {
  return run('gl_accounts:create', { surface: 'finance/chart-of-accounts', action: 'create_account' }, async (ctx) => {
    const a = await fin().setup.createAccount(ctx, input);
    return { id: a.id };
  }, [`${ROOT}/accounts`]);
}

export async function updateAccountAction(id: string, input: AccountInput) {
  return run('gl_accounts:edit', { surface: 'finance/chart-of-accounts', action: 'edit_account' }, async (ctx) => {
    await fin().setup.updateAccount(ctx, id, input);
  }, [`${ROOT}/accounts`]);
}

export async function setAccountBlockedAction(id: string, blocked: boolean, reason?: string) {
  return run('gl_accounts:block', { surface: 'finance/chart-of-accounts', action: blocked ? 'block_account' : 'unblock_account' }, (ctx) =>
    fin().setup.setBlocked(ctx, id, blocked, reason),
  [`${ROOT}/accounts`]);
}

export async function deleteAccountAction(id: string) {
  return run('gl_accounts:delete', { surface: 'finance/chart-of-accounts', action: 'delete_account' }, (ctx) =>
    fin().setup.deleteAccount(ctx, id),
  [`${ROOT}/accounts`]);
}

// ── fiscal calendar ──────────────────────────────────────────────────────

export async function listFiscalAction() {
  return run('fiscal_calendar:read', { surface: 'finance/fiscal-calendar', action: 'list' }, async (ctx) => {
    const years = await fin().fiscal.listYears(ctx.companyId);
    return years.map((y) => ({
      id: y.id,
      code: y.code,
      startsOn: y.startsOn,
      endsOn: y.endsOn,
      shape: y.shape,
      periods: y.periods.map((p) => ({
        id: p.id,
        no: p.no,
        name: p.name,
        startsOn: p.startsOn,
        endsOn: p.endsOn,
        status: p.status,
      })),
    }));
  });
}
export type FiscalYearView = Extract<Awaited<ReturnType<typeof listFiscalAction>>, { ok: true }>['data'][number];

export async function createFiscalYearAction(startsOn: string, shape: CalendarShape) {
  return run('fiscal_calendar:edit', { surface: 'finance/fiscal-calendar', action: 'create_year' }, async (ctx) => {
    const y = await fin().fiscal.createYear(ctx, { startsOn, shape });
    return { id: y.id };
  }, [`${ROOT}/periods`]);
}

/** The permission depends on the move (close, reopen, lock), so it is looked up first. */
export async function setPeriodStatusAction(periodId: string, to: PeriodStatus, reason?: string) {
  try {
    const company = await getContainer().companySettings.ensureSeeded();
    const { transition } = await fin().fiscal.requiredPermission(company.id, periodId, to);
    if (!transition) {
      return { ok: false, error: 'That change is not allowed for this period.', code: 'TRANSITION_ILLEGAL' } as FinanceResult<void>;
    }
    return run(
      transition.permission as PermissionKey,
      { surface: 'finance/fiscal-calendar', action: `period_${to}` },
      (ctx) => fin().fiscal.setStatus(ctx, periodId, to, reason),
      [`${ROOT}/periods`],
    );
  } catch (error: unknown) {
    if (error instanceof FinanceError) return { ok: false, error: error.message, code: error.code } as FinanceResult<void>;
    console.error('[finance]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' } as FinanceResult<void>;
  }
}

// ── posting setup ────────────────────────────────────────────────────────

export async function postingSetupAction() {
  return run('posting_setup:read', { surface: 'finance/posting-setup', action: 'view' }, async (ctx) => {
    const ov = await fin().postingSetup.overview(ctx.companyId);
    // Only the accounts the setup names are looked up; the rest are searched for when one is chosen.
    const named = new Set<string>();
    for (const g of ov.general) for (const id of [g.salesAccountId, g.salesReturnsAccountId, g.salesDiscountAccountId, g.cogsAccountId, g.inventoryAdjustmentAccountId]) if (id !== null) named.add(id);
    for (const c of ov.customer) for (const id of [c.receivablesAccountId, c.customerDepositsAccountId, c.refundsPayableAccountId, c.paymentDiscountAccountId, c.writeOffAccountId, c.roundingAccountId, c.fxGainAccountId, c.fxLossAccountId, c.serviceChargeAccountId, c.rebateExpenseAccountId, c.giftCardLiabilityAccountId, c.loyaltyProvisionAccountId]) if (id !== null) named.add(id);
    const accountLabels = await fin().setup.accountLabels(ctx.companyId, [...named]);
    return {
      business: ov.business.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      product: ov.product.map((p) => ({ id: p.id, code: p.code, name: p.name })),
      general: ov.general.map((g) => ({
        id: g.id,
        businessGroupId: g.businessGroupId,
        productGroupId: g.productGroupId,
        effectiveFrom: g.effectiveFrom,
        effectiveTo: g.effectiveTo,
        accounts: {
          sales: g.salesAccountId,
          sales_returns: g.salesReturnsAccountId,
          sales_discount: g.salesDiscountAccountId,
          cogs: g.cogsAccountId,
          inventory_adjustment: g.inventoryAdjustmentAccountId,
        },
      })),
      customer: ov.customer.map((c) => {
        const accounts: Record<string, string | null> = {
            receivables: c.receivablesAccountId,
            customer_deposits: c.customerDepositsAccountId,
            refunds_payable: c.refundsPayableAccountId,
            payment_discount: c.paymentDiscountAccountId,
            write_off: c.writeOffAccountId,
            rounding: c.roundingAccountId,
            fx_gain: c.fxGainAccountId,
            fx_loss: c.fxLossAccountId,
            service_charge: c.serviceChargeAccountId,
            rebate_expense: c.rebateExpenseAccountId,
            gift_card_liability: c.giftCardLiabilityAccountId,
            loyalty_provision: c.loyaltyProvisionAccountId,
        };
        return { id: c.id, code: c.code, name: c.name, accounts };
      }),
      accountLabels,
      canEdit: await canPermission('posting_setup:edit'),
    };
  });
}
export async function saveCustomerGroupAction(code: string, accounts: Record<string, string | null>) {
  return run(
    'posting_setup:edit',
    { surface: 'finance/posting-setup', action: 'save_customer_group' },
    async (ctx) => fin().salesPosting.saveCustomerGroupAccounts(ctx, code, accounts),
    [`${ROOT}/posting-setup`, `${ROOT}/sales-posting`],
  );
}

export type PostingSetupView = Extract<Awaited<ReturnType<typeof postingSetupAction>>, { ok: true }>['data'];

export async function addPostingGroupAction(kind: 'business' | 'product', code: string, name: string) {
  return run('posting_setup:edit', { surface: 'finance/posting-setup', action: 'add_group' }, (ctx) =>
    fin().postingSetup.addGroup(ctx, kind, code, name),
  [`${ROOT}/posting-setup`]);
}

export async function saveGeneralSetupAction(input: {
  businessGroupId: string;
  productGroupId: string;
  effectiveFrom: string;
  accounts: Partial<Record<GeneralPurpose, string | null>>;
}) {
  return run('posting_setup:edit', { surface: 'finance/posting-setup', action: 'save_general_setup' }, (ctx) =>
    fin().postingSetup.saveGeneral(ctx, input),
  [`${ROOT}/posting-setup`]);
}

// ── journals ─────────────────────────────────────────────────────────────

export async function listBatchesAction() {
  return run('journals:read', { surface: 'finance/journals', action: 'list_batches' }, async (ctx) =>
    (await fin().journals.listBatches(ctx.companyId)).map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      lineCount: b.lineCount,
    })),
  );
}

export async function createBatchAction(code: string, name: string) {
  return run('journal_batches:create', { surface: 'finance/journals', action: 'create_batch' }, async (ctx) => {
    const b = await fin().journals.createBatch(ctx, code, name);
    return { id: b.id };
  }, [`${ROOT}/journals`]);
}

export async function getBatchAction(batchId: string) {
  return run('journals:read', { surface: 'finance/journals/batch', action: 'view' }, async (ctx) => {
    const data = await fin().journals.getBatch(ctx.companyId, batchId);
    if (!data) throw new FinanceError('NOT_FOUND', 'That batch does not exist.');
    const settings = await fin().setup.getSettings(ctx.companyId);
    return {
      batch: { id: data.batch.id, code: data.batch.code, name: data.batch.name },
      baseCurrency: settings?.baseCurrency ?? '',
      lines: data.lines,
      can: {
        edit: await canPermission('journals:edit_draft'),
        preview: await canPermission('journals:preview'),
        post: await canPermission('journals:post'),
      },
    };
  });
}
export type BatchView = Extract<Awaited<ReturnType<typeof getBatchAction>>, { ok: true }>['data'];

export async function saveJournalLineAction(batchId: string, input: LineInput, lineId?: string) {
  return run('journals:edit_draft', { surface: 'finance/journals/batch', action: has(lineId) ? 'edit_line' : 'add_line' }, (ctx) =>
    fin().journals.saveLine(ctx, batchId, input, lineId),
  );
}

export async function deleteJournalLineAction(batchId: string, lineId: string) {
  return run('journals:edit_draft', { surface: 'finance/journals/batch', action: 'delete_line' }, (ctx) =>
    fin().journals.deleteLine(ctx, batchId, lineId),
  );
}

export async function previewBatchAction(batchId: string) {
  return run('journals:preview', { surface: 'finance/journals/batch', action: 'preview' }, async (ctx) =>
    fin().journals.preview(ctx, batchId, await postingPermissions()),
  );
}

export async function postBatchAction(batchId: string) {
  return run('journals:post', { surface: 'finance/journals/batch', action: 'post_batch' }, async (ctx) => {
    const posted = await fin().journals.post(ctx, batchId, await postingPermissions());
    return posted.map((p) => ({ registerId: p.registerId, seq: p.seq, chainKey: p.chainKey }));
  }, [`${ROOT}/journals`, `${ROOT}/entries`]);
}

export async function reverseRegisterAction(registerId: string, postingDate: string, reason: { code: string; text?: string }) {
  return run('ledger_entries:reverse', { surface: 'finance/registers', action: 'reverse' }, async (ctx) => {
    const r = await getContainer().reasonCodes.require(ctx.companyId, reason, 'finance.reverse');
    const posted = await fin().engine.reverse({
      companyId: ctx.companyId,
      registerId,
      postingDate,
      reasonCode: r.code,
      reasonText: r.text,
      origin: ctx.origin,
      permissions: await postingPermissions(),
    });
    return { registerId: posted.registerId };
  }, [`${ROOT}/entries`, `${ROOT}/registers`]);
}

// ── ledgers and reports ──────────────────────────────────────────────────

export async function trialBalanceAction(from: string, to: string) {
  return run('trial_balance:read', { surface: 'finance/trial-balance', action: 'view' }, (ctx) =>
    fin().reports.trialBalance(ctx.companyId, from, to),
  );
}

export async function glEntriesAction(filter: {
  accountId?: string;
  from?: string;
  to?: string;
  documentNo?: string;
  registerId?: string;
  cursor?: { date: string; id: number };
}) {
  return run('gl_entries:read', { surface: 'finance/entries', action: 'list' }, async (ctx) => {
    return await fin().reports.entries(ctx.companyId, filter);
  });
}

export async function registersAction() {
  return run('ledger_registers:read', { surface: 'finance/registers', action: 'list' }, async (ctx) => {
    const rows = await fin().reports.registers(ctx.companyId, 100);
    const { inArray } = await import('drizzle-orm');
    const { registerReversals } = await import('@/server/db/drizzle/schema');
    const reversed = rows.length === 0 ? [] : await getContainer().db.select({ originalId: registerReversals.originalId }).from(registerReversals).where(inArray(registerReversals.originalId, rows.map((r) => r.id)));
    const done = new Set(reversed.map((r) => r.originalId));
    return {
      registers: rows.map((r) => ({
        id: r.id,
        chainKey: r.chainKey,
        seq: r.seq,
        documentType: r.documentType,
        documentNo: r.documentNo,
        description: r.description,
        postingDate: r.postingDate,
        currency: r.currency,
        total: r.totalDebit,
        lineCount: r.lineCount,
        postedBy: r.postedById,
        postedAt: r.postedAt.toISOString(),
        isReversal: r.reversalOfId !== null,
        reversed: done.has(r.id),
        origin: r.origin,
        hash: r.hash,
      })),
      canReverse: await canPermission('ledger_entries:reverse'),
    };
  });
}
export type RegisterView = Extract<Awaited<ReturnType<typeof registersAction>>, { ok: true }>['data']['registers'][number];

export async function registerDetailAction(registerId: string) {
  return run('ledger_registers:read', { surface: 'finance/registers', action: 'view_register' }, async (ctx) => {
    const r = await fin().reports.register(ctx.companyId, registerId);
    if (!r) throw new FinanceError('NOT_FOUND', 'That posting does not exist.');
    const trail = await getContainer().decisionLog.timeline('ledger_register', registerId);
    return {
      lines: r.lines,
      origin: r.register.origin,
      previousHash: r.register.previousHash,
      hash: r.register.hash,
      trail: trail.map((t) => ({ at: t.occurredAt.toISOString(), action: t.action, actor: t.actorId, reason: t.reasonText ?? t.reasonCode })),
    };
  });
}

export async function verifyChainAction() {
  return run('ledger_registers:read', { surface: 'finance/registers', action: 'verify_chain' }, (ctx) =>
    fin().reports.verifyChain(ctx.companyId),
  );
}
