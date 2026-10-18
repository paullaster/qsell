import { and, eq, inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, branches, glAccounts, paymentMethods, paymentProviderConfigs } from '@/server/db/drizzle/schema';
import {
  ALLOCATION_MODES,
  CHANNEL_KINDS,
  EVENT_STATES,
  MANUAL_OR_AUTOMATIC_REFUND,
  METHOD_KINDS,
  PAYMENT_SERVICES,
  PROVIDER_ENVIRONMENTS,
  TIMEOUT_RESPONSES,
  TRANSACTION_STATES,
  VALIDATION_ANSWERS,
  VERIFICATION_MODES,
  stateChoices,
  type Choice,
} from '@/lib/payment-options';
import { canPermission } from '@/server/domains/access-control/guard';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { darajaSettings, OPERATION_DEFAULTS } from './daraja/config';
import { DARAJA_OPERATIONS, type DarajaOperationCode } from './daraja/catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const option = (c: Choice) => ({ id: c.id, label: c.label, description: null });

/** A fixed list that takes no filters. */
const fixed = (key: string, permission: 'payment_providers:read' | 'payment_methods:read' | 'payment_activity:read', list: readonly Choice[]) =>
  staticSource({
    key,
    permission,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map(option);
    },
  });

const uuidFilter = (filters: Record<string, string>, name: string): string | null => {
  const rest = Object.keys(filters).filter((key) => key !== name);
  if (rest.length > 0) throw new LookupFilterError('Unsupported filter.');
  const value = Object.hasOwn(filters, name) ? filters[name] : '';
  if (value === '') return null;
  if (!UUID.test(value)) throw new LookupFilterError('Unsupported filter.');
  return value;
};

const branchesSource = tableSource({
  key: 'branches',
  permission: 'branches:read',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(branches.companyId, companyId), eq(branches.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: `${String(row.code)} — ${String(row.label)}`, description: null, badge: null }),
});

const bankAccountsSource = tableSource({
  key: 'bank-accounts',
  permission: 'bank_accounts:read',
  table: bankAccounts,
  id: bankAccounts.id,
  label: bankAccounts.name,
  searchColumns: [bankAccounts.name, bankAccounts.code],
  select: { code: bankAccounts.code, currency: bankAccounts.currency },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(bankAccounts.companyId, companyId), eq(bankAccounts.blocked, false)];
  },
  toOption: (row) => ({ id: String(row.id), label: `${String(row.code)} — ${String(row.label)} (${String(row.currency)})`, description: null, badge: null }),
});

/** Accounts the money of a payment method may be booked to: open posting accounts under Assets. */
const assetAccountsSource = tableSource({
  key: 'asset-gl-accounts',
  permission: 'gl_accounts:read',
  table: glAccounts,
  id: glAccounts.id,
  label: glAccounts.no,
  searchColumns: [glAccounts.no, glAccounts.name],
  select: { name: glAccounts.name },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.category, 'assets')];
  },
  toOption: (row) => ({ id: String(row.id), label: `${String(row.label)} ${String(row.name)}`, description: null, badge: null }),
});

/** The paybills and tills under a provider, or under any M-Pesa provider when none is named. */
/** Rows that have a number, with the number trimmed (a method without one is not a paybill or till). */
const withNumber = <T extends { number: string | null }>(rows: T[]): (T & { number: string })[] =>
  rows.flatMap((row) => {
    const number = row.number?.trim() ?? '';
    return number === '' ? [] : [{ ...row, number }];
  });

const providerNumbers = staticSource({
  key: 'provider-numbers',
  permission: 'payment_methods:read',
  async items({ companyId, filters }) {
    const providerId = uuidFilter(filters, 'provider');
    const rows = await drizzleDb
      .select({ id: paymentMethods.id, name: paymentMethods.name, kind: paymentMethods.channelKind, number: paymentMethods.channelNumber })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), ...(providerId === null ? [] : [eq(paymentMethods.providerId, providerId)])))
      .limit(500);
    return withNumber(rows).map((r) => ({ id: r.id, label: `${r.name} (${r.kind ?? 'number'} ${r.number})`, description: null }));
  },
});

/** The company's paybills at M-Pesa providers, for Bill Manager. */
const billPaybills = staticSource({
  key: 'bill-paybills',
  permission: 'payment_operations:run',
  async items({ companyId, filters }) {
    acceptFilters(filters, {});
    const providers = await drizzleDb.select({ id: paymentProviderConfigs.id }).from(paymentProviderConfigs).where(and(eq(paymentProviderConfigs.companyId, companyId), eq(paymentProviderConfigs.providerCode, 'mpesa_daraja')));
    if (providers.length === 0) return [];
    const rows = await drizzleDb
      .select({ id: paymentMethods.id, name: paymentMethods.name, number: paymentMethods.channelNumber })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), eq(paymentMethods.channelKind, 'paybill'), inArray(paymentMethods.providerId, providers.map((p) => p.id))))
      .limit(500);
    return withNumber(rows).map((r) => ({ id: r.id, label: `${r.name} · paybill ${r.number}`, description: null }));
  },
});

/** The operations this person may run on one M-Pesa provider: enabled for it, a form, and allowed to them. */
const darajaOperations = staticSource({
  key: 'daraja-operations',
  permission: 'payment_operations:run',
  async items({ companyId, filters }) {
    const providerId = uuidFilter(filters, 'provider');
    if (providerId === null) throw new LookupFilterError('Choose a provider first.');
    const found = await drizzleDb
      .select({ settings: paymentProviderConfigs.settings, code: paymentProviderConfigs.providerCode })
      .from(paymentProviderConfigs)
      .where(and(eq(paymentProviderConfigs.id, providerId), eq(paymentProviderConfigs.companyId, companyId)));
    const provider = found.at(0);
    if (provider?.code !== 'mpesa_daraja') return [];
    const settings = darajaSettings(provider.settings);
    const mayRun = await canPermission('payment_operations:run');
    const mayPay = await canPermission('payment_operations:request_payout');
    return Object.values(DARAJA_OPERATIONS)
      .filter((o) => (Object.hasOwn(settings.operations, o.code) ? settings.operations[o.code].enabled : OPERATION_DEFAULTS[o.code]) === true && o.internal !== true && (o.moneyOut ? mayPay : mayRun))
      .map((o) => ({ id: o.code, label: o.label, description: o.moneyOut ? 'Moves money out · needs approval' : null }));
  },
});

/** The choices of one select-type field of one operation. */
const darajaFieldOptions = staticSource({
  key: 'daraja-field-options',
  permission: 'payment_operations:run',
  items({ filters }) {
    const { operation = '', field = '', ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    const info = Object.hasOwn(DARAJA_OPERATIONS, operation) ? DARAJA_OPERATIONS[operation as DarajaOperationCode] : null;
    const spec = info?.fields.find((f) => f.key === field);
    if (spec?.type !== 'select') throw new LookupFilterError('Unsupported filter.');
    return (spec.options ?? []).map(([id, label]) => ({ id, label, description: null }));
  },
});

const BILL_STATUS_CHOICES = [
  { id: 'sent', label: 'Sent, not paid' },
  { id: 'part_paid', label: 'Part paid' },
  { id: 'paid', label: 'Paid' },
  { id: 'requested', label: 'Being sent' },
  { id: 'failed', label: 'Refused' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;

export const PAYMENT_LOOKUP_SOURCES: readonly LookupSource[] = [
  fixed('provider-environments', 'payment_providers:read', PROVIDER_ENVIRONMENTS),
  fixed('payment-services', 'payment_providers:read', PAYMENT_SERVICES),
  fixed('mpesa-verification-modes', 'payment_providers:read', VERIFICATION_MODES),
  fixed('mpesa-timeout-responses', 'payment_providers:read', TIMEOUT_RESPONSES),
  fixed('mpesa-validation-answers', 'payment_providers:read', VALIDATION_ANSWERS),
  fixed('mpesa-allocation-modes', 'payment_providers:read', ALLOCATION_MODES),
  fixed('payment-method-kinds', 'payment_methods:read', METHOD_KINDS),
  fixed('payment-channel-kinds', 'payment_methods:read', CHANNEL_KINDS),
  fixed('refund-payout-modes', 'payment_methods:read', MANUAL_OR_AUTOMATIC_REFUND),
  fixed('bill-invoice-statuses', 'payment_activity:read', BILL_STATUS_CHOICES),
  fixed('payment-event-states', 'payment_activity:read', stateChoices(EVENT_STATES)),
  fixed('payment-transaction-states', 'payment_activity:read', stateChoices(TRANSACTION_STATES)),
  branchesSource,
  bankAccountsSource,
  assetAccountsSource,
  providerNumbers,
  billPaybills,
  darajaOperations,
  darajaFieldOptions,
];
