import { eq, sql } from 'drizzle-orm';
import { bankAccounts, customers, paymentMethods, reasonCodes } from '@/server/db/drizzle/schema';
import { CHEQUE_STATUS, RECEIPT_STATUS, REFUND_STATUS, statusChoices } from '@/lib/finance-statuses';
import { METHOD_KINDS, labelOf } from '@/lib/payment-options';
import { AUTO_APPLY_MODES, CREDIT_NOTE_MODES, OVERPAYMENT_MODES } from '@/lib/wallet-policy';
import { CONDITIONS, DISPOSITIONS } from '@/lib/return-form';
import { CREDIT_NOTE_REASONS } from '@/server/domains/credit-notes/reasons';
import { reasonLabel } from '@/lib/credit-note-form';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
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
const customerSource = (key: string, permission: 'receipts:create' | 'refunds:create') =>
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

const methodSource = (key: string, permission: 'receipts:create' | 'refunds:create', usedFor: 'customer_receipt' | 'customer_refund', manualRefundOnly: boolean) =>
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
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true)];
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

/** Methods a refund can be paid out through by hand: open, in the refund's currency, not cheques. */
const refundPayoutMethods = tableSource({
  key: 'refund-payout-methods',
  permission: 'refunds:record_manual_payout',
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

const fixedChoices = (key: string, permission: PermissionKey, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

const fixedStatuses = (key: string, permission: 'receipts:read' | 'refunds:read', table: Parameters<typeof statusChoices>[0]) =>
  staticSource({
    key,
    permission,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return statusChoices(table).map((c) => ({ ...c, description: null }));
    },
  });

export const FINANCE_LOOKUP_SOURCES: readonly LookupSource[] = [
  customerSource('receipt-customers', 'receipts:create'),
  customerSource('refund-customers', 'refunds:create'),
  methodSource('receipt-methods', 'receipts:create', 'customer_receipt', false),
  methodSource('refund-methods', 'refunds:create', 'customer_refund', true),
  reasons('receipt-reasons', 'receipts:read'),
  reasons('refund-reasons', 'refunds:read'),
  chequeDepositMethods,
  refundPayoutMethods,
  fixedChoices('allocation-modes', 'receipts:read', ALLOCATION_CHOICES),
  reasons('wallet-reasons', 'wallet:read'),
  reasons('return-close-reasons', 'return_receipts:read'),
  fixedChoices('wallet-overpayment-modes', 'wallet:read', OVERPAYMENT_MODES),
  fixedChoices('wallet-auto-apply-modes', 'wallet:read', AUTO_APPLY_MODES),
  fixedChoices('wallet-credit-note-modes', 'wallet:read', CREDIT_NOTE_MODES),
  fixedChoices('return-conditions', 'return_receipts:read', CONDITIONS),
  fixedChoices('return-dispositions', 'return_receipts:read', DISPOSITIONS),
  fixedChoices('credit-note-reasons', 'credit_notes:create', CREDIT_NOTE_REASONS.map((id) => ({ id, label: reasonLabel(id) }))),
  refundSources,
  fixedStatuses('receipt-statuses', 'receipts:read', RECEIPT_STATUS),
  fixedStatuses('cheque-statuses', 'receipts:read', CHEQUE_STATUS),
  fixedStatuses('refund-statuses', 'refunds:read', REFUND_STATUS),
];
