import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { APPLIES_ANYWHERE } from '@/server/kernel/reason-codes/lookup-sources';
import { LIMIT_MODES } from '@/lib/refund-limits-form';
import { bankAccounts, customers, glAccounts, paymentMethods, paymentProviderConfigs, reasonCodes } from '@/server/db/drizzle/schema';
import { ADJUSTMENT_STATUS, CHEQUE_STATUS, RECEIPT_STATUS, REFUND_FILE_STATUS, REFUND_STATUS, statusChoices } from '@/lib/finance-statuses';
import { METHOD_KINDS, labelOf } from '@/lib/payment-options';
import { AUTO_APPLY_MODES, CREDIT_NOTE_MODES, OVERPAYMENT_MODES } from '@/lib/wallet-policy';
import { CONDITIONS, DISPOSITIONS } from '@/lib/return-form';
import { CREDIT_NOTE_REASONS } from '@/server/domains/credit-notes/reasons';
import { reasonLabel } from '@/lib/credit-note-form';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { ACCOUNT_CATEGORIES, ACCOUNT_TYPES, CALENDAR_SHAPES, DIMENSION_RULES, NORMAL_BALANCES } from '@/lib/gl-options';
import { BANK_KINDS } from '@/lib/bank-account-form';
import { DATE_FORMATS } from '@/lib/statement-import-form';
import { CERTAINTY_CHOICES, SUGGEST_CHOICES } from '@/lib/bank-match-form';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const ALLOCATION_CHOICES = [
  { id: 'oldest_first', label: 'Apply to oldest invoices' },
  { id: 'none', label: 'Leave unapplied' },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const joinText = (parts: unknown[]): string | null => {
  const out = parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
  return out === '' ? null : out;
};

/** Customers a person may take money from or pay back: name, number, phone or email. */
const customerSource = (key: string, permission: PermissionKey) =>
  tableSource({
    key,
    permission,
    table: customers,
    id: customers.id,
    label: customers.name,
    searchColumns: [customers.name, customers.number, customers.phone, customers.email],
    select: { number: customers.number, phone: customers.phone, email: customers.email, accountType: customers.accountType, balance: customers.balance },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(customers.companyId, companyId), eq(customers.isActive, true)];
    },
    toOption: (row) => ({
      id: text(row.id),
      label: text(row.label),
      description: joinText([row.number, row.phone, row.email]),
      badge: row.accountType === 'credit' ? 'Credit' : null,
      meta: { number: text(row.number), phone: text(row.phone), accountType: text(row.accountType), balance: text(row.balance) },
    }),
  });

const bankCurrency = sql<string>`(select ${bankAccounts.currency} from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId})`;
const bankLabel = sql<string>`(select ${bankAccounts.code} || ' — ' || ${bankAccounts.name} from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId})`;
const bankOpen = sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.blocked} = false)`;

const methodSource = (key: string, permission: PermissionKey, usedFor: 'customer_receipt' | 'customer_refund', manualRefundOnly: boolean) =>
  tableSource({
    key,
    permission,
    table: paymentMethods,
    id: paymentMethods.id,
    label: paymentMethods.name,
    searchColumns: [paymentMethods.name, paymentMethods.code],
    select: {
      kind: paymentMethods.kind,
      requiresReference: paymentMethods.requiresReference,
      requiresEvidence: paymentMethods.requiresEvidence,
      requiresCounterparty: paymentMethods.requiresCounterparty,
      limits: paymentMethods.limits,
      currency: bankCurrency,
      bank: bankLabel,
    },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [
        eq(paymentMethods.companyId, companyId),
        eq(paymentMethods.enabled, true),
        bankOpen,
        sql`${paymentMethods.usableFor} @> ${JSON.stringify([usedFor])}::jsonb`,
        ...(manualRefundOnly ? [eq(paymentMethods.refundDestination, 'manual')] : []),
      ];
    },
    toOption: (row) => {
      const limits = (typeof row.limits === 'object' && row.limits !== null ? row.limits : {}) as { min?: string; max?: string };
      return {
        id: text(row.id),
        label: text(row.label),
        description: joinText([labelOf(METHOD_KINDS, text(row.kind)), text(row.bank)]),
        badge: null,
        meta: {
          kind: text(row.kind),
          currency: text(row.currency),
          bank: text(row.bank),
          requiresReference: row.requiresReference === true ? '1' : '',
          requiresEvidence: row.requiresEvidence === true ? '1' : '',
          requiresCounterparty: row.requiresCounterparty === true ? '1' : '',
          min: limits.min ?? '',
          max: limits.max ?? '',
        },
      };
    },
  });

/** Reasons a refund or a reversal can be given. */
const reasons = (key: string, permission: PermissionKey) =>
  tableSource({
    key,
    permission,
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), APPLIES_ANYWHERE];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null, meta: { requiresComment: row.requiresComment === true ? '1' : '' } }),
  });

/** What a customer is owed that a refund can be taken from; the customer is the one filter. */
const refundSources = staticSource({
  key: 'refund-sources',
  permission: 'refunds:create',
  async items({ companyId, filters }) {
    const { customer = '', ...rest } = filters;
    if (Object.keys(rest).length > 0 || !UUID.test(customer)) throw new LookupFilterError('Choose the customer first.');
    const rows = await getContainer().finance.refunds.obligations(companyId, customer);
    return rows.map((o) => ({
      id: `${o.kind}:${o.id}`,
      label: o.label,
      description: `${o.currency} ${(o.availableCents / 100).toFixed(2)} left`,
      meta: { kind: o.kind, sourceId: o.id, currency: o.currency, available: (o.availableCents / 100).toFixed(2) },
    }));
  },
});

/** What a customer is owed that can be given up (an excess on a credit note, an unapplied receipt); the customer is the one filter. */
const adjustmentSources = staticSource({
  key: 'adjustment-sources',
  permission: 'credit_adjustments:request',
  async items({ companyId, filters }) {
    const { customer = '', ...rest } = filters;
    if (Object.keys(rest).length > 0 || !UUID.test(customer)) throw new LookupFilterError('Choose the customer first.');
    const rows = await getContainer().finance.refunds.obligations(companyId, customer);
    return rows
      .filter((o) => o.kind === 'credit_note_excess' || o.kind === 'receipt_unapplied')
      .map((o) => ({
        id: `${o.kind}:${o.id}`,
        label: o.label,
        description: `${o.currency} ${(o.availableCents / 100).toFixed(2)} left`,
        meta: { kind: o.kind, sourceId: o.id, currency: o.currency, available: (o.availableCents / 100).toFixed(2) },
      }));
  },
});

const ADJUSTMENT_KINDS = [
  { id: 'waive_excess', label: 'Give up credit the customer is owed' },
  { id: 'wallet_increase', label: 'Add to the customer\'s wallet' },
  { id: 'wallet_decrease', label: 'Take off the customer\'s wallet' },
] as const;

/** Banks (as payment methods) a received cheque can be deposited into. */
const chequeDepositMethods = tableSource({
  key: 'cheque-deposit-methods',
  permission: 'cheques:deposit',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: { bank: bankLabel, currency: bankCurrency },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [
      eq(paymentMethods.companyId, companyId),
      eq(paymentMethods.enabled, true),
      sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.kind} = 'bank' and ${bankAccounts.blocked} = false)`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} — ${text(row.bank)}`, description: null, badge: null, meta: { currency: text(row.currency) } }),
});

/** Methods money can be paid out through, or come back into, by hand: open, in one currency, not cheques. */
const payoutMethods = (key: string, permission: PermissionKey) =>
  tableSource({
    key,
    permission,
    table: paymentMethods,
    id: paymentMethods.id,
    label: paymentMethods.name,
    searchColumns: [paymentMethods.name, paymentMethods.code],
    select: { bank: bankLabel },
    scope: ({ companyId, filters }) => {
      const { currency = '', ...rest } = filters;
      if (Object.keys(rest).length > 0 || !/^[A-Z]{3}$/.test(currency)) throw new LookupFilterError('Unsupported filter.');
      return [
        eq(paymentMethods.companyId, companyId),
        eq(paymentMethods.enabled, true),
        sql`${paymentMethods.kind} <> 'cheque'`,
        bankOpen,
        sql`${bankCurrency} = ${currency}`,
      ];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} — ${text(row.bank)}`, description: null, badge: null }),
  });

/** Methods that pay out of a real bank account (not cash, not mobile money): what a bank payment file is paid from. */
const refundFileMethods = tableSource({
  key: 'refund-file-methods',
  permission: 'refund_files:generate',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: { bank: bankLabel, currency: bankCurrency },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [
      eq(paymentMethods.companyId, companyId),
      eq(paymentMethods.enabled, true),
      sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.kind} = 'bank' and ${bankAccounts.blocked} = false)`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} — ${text(row.bank)}`, description: null, badge: null, meta: { currency: text(row.currency) } }),
});

const fixedChoices = (key: string, permission: PermissionKey, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

const fixedStatuses = (key: string, permission: PermissionKey, table: Parameters<typeof statusChoices>[0]) =>
  staticSource({
    key,
    permission,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return statusChoices(table).map((c) => ({ ...c, description: null }));
    },
  });

/** Open posting accounts under Expenses: where bank and mobile-money charges post. */
const expenseAccounts = tableSource({
  key: 'expense-gl-accounts',
  permission: 'gl_accounts:read',
  table: glAccounts,
  id: glAccounts.id,
  label: glAccounts.no,
  searchColumns: [glAccounts.no, glAccounts.name],
  select: { name: glAccounts.name },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.category, 'expense')];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
});

/** The bank connections a statement can be read through: providers whose driver gives statements. */
const statementProviders = tableSource({
  key: 'statement-providers',
  permission: 'bank_accounts:read',
  table: paymentProviderConfigs,
  id: paymentProviderConfigs.id,
  label: paymentProviderConfigs.displayName,
  searchColumns: [paymentProviderConfigs.displayName],
  select: { code: paymentProviderConfigs.providerCode },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(paymentProviderConfigs.companyId, companyId), inArray(paymentProviderConfigs.providerCode, ['jenga_hq', 'kcb_buni'])];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code) === 'jenga_hq' ? 'Jenga' : 'KCB Buni', badge: null }),
});

/** Open posting accounts of one category, for the statement panels: asked for under the permission of the thing being done, not the chart's. */
const statementAccounts = (key: string, permission: PermissionKey, categories: ('income' | 'expense')[]) =>
  tableSource({
    key,
    permission,
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), inArray(glAccounts.category, categories)];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  });

const statementIncomeAccounts = statementAccounts('statement-income-accounts', 'bank_statements:record_income', ['income']);
const statementExpenseAccounts = statementAccounts('statement-expense-accounts', 'bank_statements:record_charge', ['expense'])
const cashVarianceAccounts = statementAccounts('cash-variance-accounts', 'cash_counts:post', ['expense', 'income']);

const accountFilter = (filters: Record<string, string>): string => {
  const { account = '', ...rest } = filters;
  if (Object.keys(rest).length > 0 || !UUID.test(account)) throw new LookupFilterError('Choose the account first.');
  return account;
};

/** Payment methods that pay into one bank account, for turning a statement line into a receipt. */
const statementReceiptMethods = tableSource({
  key: 'statement-receipt-methods',
  permission: 'bank_statements:create_receipt',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: {},
  scope: ({ companyId, filters }) => [
    eq(paymentMethods.companyId, companyId),
    eq(paymentMethods.enabled, true),
    eq(paymentMethods.balancingBankAccountId, accountFilter(filters)),
    sql`${paymentMethods.usableFor} @> '["customer_receipt"]'::jsonb`,
  ],
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null }),
});

/** The G/L accounts the methods of one bank account post to, which a charge may come out of. */
const statementChargeAccounts = staticSource({
  key: 'statement-charge-accounts',
  permission: 'bank_statements:record_charge',
  async items({ companyId, filters }) {
    const rows = await getContainer().finance.bankStatements.chargeGlChoices(companyId, accountFilter(filters));
    return rows.map((g) => ({ id: g.glId, label: g.label, description: g.methods.join(', ') }));
  },
});

/** The G/L accounts the methods of one cash account post to, which a counted difference is written against. */
const cashCountGlAccounts = staticSource({
  key: 'cash-count-gl-accounts',
  permission: 'cash_counts:post',
  async items({ companyId, filters }) {
    const rows = await getContainer().finance.bankStatements.chargeGlChoices(companyId, accountFilter(filters));
    return rows.map((g) => ({ id: g.glId, label: g.label, description: g.methods.join(', ') }));
  },
});

/** Posting accounts of the chart, searched by number or name; what a ledger screen filters or posts by. */
const glPostingAccounts = (key: string, permission: PermissionKey, extra: (companyId: string) => SQL[]) =>
  tableSource({
    key,
    permission,
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name, control: glAccounts.postingSource },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), ...extra(companyId)];
    },
    toOption: (row) => ({
      id: text(row.id),
      label: `${text(row.label)} ${text(row.name)}`,
      description: row.control === 'engine_only' ? 'Control account: posted by its sub-ledger only' : null,
      badge: null,
    }),
  });

export const FINANCE_LOOKUP_SOURCES: readonly LookupSource[] = [
  fixedChoices('gl-account-types', 'gl_accounts:read', ACCOUNT_TYPES),
  fixedChoices('gl-account-categories', 'gl_accounts:read', ACCOUNT_CATEGORIES),
  fixedChoices('gl-normal-balances', 'gl_accounts:read', NORMAL_BALANCES),
  fixedChoices('gl-dimension-rules', 'gl_accounts:read', DIMENSION_RULES),
  fixedChoices('fiscal-calendar-shapes', 'fiscal_calendar:edit', CALENDAR_SHAPES),
  glPostingAccounts('gl-accounts', 'gl_entries:read', () => []),
  glPostingAccounts('journal-accounts', 'journals:edit_draft', () => [eq(glAccounts.blocked, false)]),
  glPostingAccounts('setup-gl-accounts', 'posting_setup:edit', () => [eq(glAccounts.blocked, false)]),
  glPostingAccounts('liability-gl-accounts', 'finance_settings:edit', () => [eq(glAccounts.blocked, false), eq(glAccounts.category, 'liabilities')]),
  glPostingAccounts('equity-gl-accounts', 'sales_gl_go_live:set', () => [eq(glAccounts.blocked, false), eq(glAccounts.category, 'equity')]),
  reasons('register-reasons', 'ledger_entries:reverse'),
  customerSource('receipt-customers', 'receipts:create'),
  customerSource('refund-customers', 'refunds:create'),
  customerSource('statement-customers', 'bank_statements:create_receipt'),
  expenseAccounts,
  statementIncomeAccounts,
  statementProviders,
  statementExpenseAccounts,
  cashVarianceAccounts,
  cashCountGlAccounts,
  statementReceiptMethods,
  statementChargeAccounts,
  reasons('statement-reasons', 'bank_statements:read'),
  fixedChoices('bank-account-kinds', 'bank_accounts:read', BANK_KINDS),
  fixedChoices('statement-allocation-modes', 'bank_statements:create_receipt', ALLOCATION_CHOICES),
  fixedChoices('match-certainty-modes', 'bank_statements:read', CERTAINTY_CHOICES),
  fixedChoices('match-suggest-modes', 'bank_statements:read', SUGGEST_CHOICES),
  fixedChoices('statement-date-formats', 'bank_statements:import', DATE_FORMATS),
  methodSource('receipt-methods', 'receipts:create', 'customer_receipt', false),
  methodSource('refund-methods', 'refunds:create', 'customer_refund', true),
  reasons('receipt-reasons', 'receipts:read'),
  reasons('refund-reasons', 'refunds:read'),
  chequeDepositMethods,
  payoutMethods('refund-payout-methods', 'refunds:record_manual_payout'),
  payoutMethods('refund-return-methods', 'refunds:record_return'),
  fixedChoices('allocation-modes', 'receipts:read', ALLOCATION_CHOICES),
  reasons('wallet-reasons', 'wallet:read'),
  reasons('return-close-reasons', 'return_receipts:read'),
  fixedChoices('wallet-overpayment-modes', 'wallet:read', OVERPAYMENT_MODES),
  fixedChoices('wallet-auto-apply-modes', 'wallet:read', AUTO_APPLY_MODES),
  fixedChoices('wallet-credit-note-modes', 'wallet:read', CREDIT_NOTE_MODES),
  fixedChoices('refund-limit-modes', 'refund_limits:read', LIMIT_MODES),
  fixedChoices('return-conditions', 'return_receipts:read', CONDITIONS),
  fixedChoices('return-dispositions', 'return_receipts:read', DISPOSITIONS),
  fixedChoices('credit-note-reasons', 'credit_notes:create', CREDIT_NOTE_REASONS.map((id) => ({ id, label: reasonLabel(id) }))),
  refundSources,
  adjustmentSources,
  refundFileMethods,
  customerSource('adjustment-customers', 'credit_adjustments:request'),
  reasons('adjustment-reasons', 'credit_adjustments:request'),
  reasons('refund-return-reasons', 'refunds:record_return'),
  reasons('refund-file-reasons', 'refund_files:cancel'),
  methodSource('gift-card-methods', 'pricing:manage', 'customer_receipt', false),
  methodSource('refund-replacement-methods', 'refunds:record_return', 'customer_refund', true),
  fixedChoices('fx-currencies', 'exchange_rates:read', [
    ['USD', 'US dollar'], ['EUR', 'Euro'], ['GBP', 'Pound sterling'], ['UGX', 'Ugandan shilling'], ['TZS', 'Tanzanian shilling'], ['RWF', 'Rwandan franc'],
    ['ZAR', 'South African rand'], ['AED', 'UAE dirham'], ['CNY', 'Chinese yuan'], ['INR', 'Indian rupee'], ['JPY', 'Japanese yen'], ['CAD', 'Canadian dollar'], ['AUD', 'Australian dollar'], ['CHF', 'Swiss franc'],
  ].map(([id = '', name = '']) => ({ id, label: `${id} · ${name}` }))),
  fixedChoices('adjustment-kinds', 'credit_adjustments:request', ADJUSTMENT_KINDS),
  fixedChoices('refund-file-formats', 'refund_files:generate', [{ id: 'csv', label: 'CSV (opens in Excel; most banks\' upload tools)' }, { id: 'pain001', label: 'ISO 20022 XML (pain.001)' }]),
  fixedStatuses('adjustment-statuses', 'credit_adjustments:read', ADJUSTMENT_STATUS),
  fixedStatuses('refund-file-statuses', 'refund_files:read', REFUND_FILE_STATUS),
  fixedStatuses('receipt-statuses', 'receipts:read', RECEIPT_STATUS),
  fixedStatuses('cheque-statuses', 'receipts:read', CHEQUE_STATUS),
  fixedStatuses('refund-statuses', 'refunds:read', REFUND_STATUS),
];
