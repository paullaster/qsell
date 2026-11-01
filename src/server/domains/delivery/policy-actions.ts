'use server';

import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { branches, chargePolicies, chargePolicyRates, currencies, customerGroups, deliveryZones, type ChargePolicyRow } from '@/server/db/drizzle/schema';
import { DEFAULT_BUSINESS_TIMEZONE, businessDate } from '@/server/kernel/numbering/business-date';
import { isDateOnly, startOfLocalDay } from './domain/time';
import { CHANNEL_WORDS } from './lookup-sources';
import { getContainer } from '@/server/di/container';
import { readGeoPoint } from '@/lib/geo';
import { afterCursor, matching, pageOf, searchText, PAGE_SIZE } from '@/server/domains/settings/paging';
import { idOf, objectOf, runDelivery, versionOf } from './action-support';
import { DeliveryError } from './errors';
import { readPolicyInput } from './domain/read';
import type { ChargePolicyDef } from './domain/types';

const PATHS = ['/admin/delivery/charges'];

export interface PolicySummary {
  id: string;
  code: string;
  version: number;
  name: string;
  method: string;
  currency: string;
  status: 'draft' | 'in_force' | 'retired';
  priority: number;
  validFrom: string;
  validTo: string | null;
  /** The first and last day it applies, as the business's calendar writes them. */
  firstDay: string;
  lastDay: string | null;
  /** Who it is for, as stored. */
  scopes: ChargePolicyRow['scopes'];
  revision: number;
}

export interface PolicyView extends PolicySummary {
  description: string | null;
  /** The words for the branches, customer groups and channels the policy names, by id. */
  scopeNames: Record<string, Record<string, string>>;
  /** The words for the zones its fees name, by id. */
  zoneNames: Record<string, string>;
  def: ChargePolicyDef;
  activatedAt: string | null;
  retiredAt: string | null;
}

const summary = (r: ChargePolicyRow): PolicySummary => ({ id: r.id, code: r.code, version: r.version, name: r.name, method: r.method, currency: r.currency, status: r.status, priority: r.priority, validFrom: r.validFrom.toISOString(), validTo: r.validTo?.toISOString() ?? null, firstDay: businessDate(r.validFrom), lastDay: r.validTo === null ? null : businessDate(new Date(r.validTo.getTime() - 1)), scopes: r.scopes, revision: r.revision });

const input = (raw: unknown) => {
  const read = readPolicyInput(raw);
  if (!read.ok) throw new DeliveryError(read.error, 'BAD_INPUT');
  return read.value;
};

/** Which statuses a list shows: by default the ones people work with, the policies in force and drafts. */
function statusFilter(status: 'all' | 'live' | 'draft' | 'retired'): SQL | undefined {
  if (status === 'all') return undefined;
  if (status === 'live') return sql`${chargePolicies.status} IN ('in_force','draft')`;
  return eq(chargePolicies.status, status);
}

/** The policies a page at a time: the newest version of each first, drafts and retired ones only on request. */
export async function chargePoliciesPageAction(raw: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const i = objectOf(raw);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const status = i.status === 'draft' || i.status === 'retired' || i.status === 'all' ? i.status : 'live';
    const conditions: (SQL | undefined)[] = [
      eq(chargePolicies.companyId, ctx.companyId),
      statusFilter(status),
      matching(query, [chargePolicies.code, chargePolicies.name]),
      afterCursor(typeof i.cursor === 'string' ? i.cursor : null, chargePolicies.code, chargePolicies.id),
    ];
    const rows = await drizzleDb.select().from(chargePolicies).where(and(...conditions)).orderBy(asc(chargePolicies.code), asc(chargePolicies.id)).limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (r) => ({ k: r.code, id: r.id }));
    return { rows: page.rows.map(summary), nextCursor: page.nextCursor };
  });
}

/** The names behind the ids a policy is limited to, in one read for each kind. */
async function scopeNames(companyId: string, scopes: ChargePolicyRow['scopes']): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = { channel: Object.fromEntries((scopes.channel?.values ?? []).map((v) => [v, CHANNEL_WORDS[v] ?? v])) };
  const branchIds = (scopes.branch?.values ?? []).filter((v) => UUID.test(v));
  if (branchIds.length > 0) out.branch = Object.fromEntries((await drizzleDb.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches).where(and(eq(branches.companyId, companyId), inArray(branches.id, branchIds)))).map((b) => [b.id, `${b.code} — ${b.name}`]));
  const groupIds = (scopes.customer_group?.values ?? []).filter((v) => UUID.test(v));
  if (groupIds.length > 0) out.customer_group = Object.fromEntries((await drizzleDb.select({ id: customerGroups.id, name: customerGroups.name, code: customerGroups.code }).from(customerGroups).where(and(eq(customerGroups.companyId, companyId), inArray(customerGroups.id, groupIds)))).map((g) => [g.id, `${g.name} (${g.code})`]));
  return out;
}

async function zoneNames(companyId: string, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await drizzleDb.select({ id: deliveryZones.id, code: deliveryZones.code, name: deliveryZones.name }).from(deliveryZones).where(and(eq(deliveryZones.companyId, companyId), inArray(deliveryZones.id, unique)));
  return Object.fromEntries(rows.map((z) => [z.id, `${z.code} · ${z.name}`]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One policy with everything the editor needs. */
export async function getChargePolicyAction(id: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const found = await getContainer().chargePolicies.get(ctx.companyId, idOf(id, 'policy'));
    if (found === null) throw new DeliveryError('That policy could not be found.', 'NOT_FOUND');
    const view: PolicyView = { ...summary(found.row), description: found.row.description, scopeNames: await scopeNames(ctx.companyId, found.row.scopes), zoneNames: await zoneNames(ctx.companyId, found.def.rates.flatMap((r) => (r.zoneId === null ? [] : [r.zoneId]))), def: found.def, activatedAt: found.row.activatedAt?.toISOString() ?? null, retiredAt: found.row.retiredAt?.toISOString() ?? null };
    return view;
  });
}

export async function createChargePolicyDraftAction(code: unknown, policy: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => {
    if (typeof code !== 'string') throw new DeliveryError('Give the policy a code.', 'BAD_INPUT');
    const row = await getContainer().chargePolicies.createDraft(ctx.companyId, { id: ctx.userId }, code, input(policy));
    return summary(row);
  }, PATHS);
}

export async function saveChargePolicyDraftAction(id: unknown, policy: unknown, revision: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => {
    const row = await getContainer().chargePolicies.saveDraft(ctx.companyId, { id: ctx.userId }, idOf(id, 'policy'), input(policy), versionOf(revision));
    return summary(row);
  }, PATHS);
}

export async function newChargePolicyVersionAction(id: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => summary(await getContainer().chargePolicies.newVersion(ctx.companyId, { id: ctx.userId }, idOf(id, 'policy'))), PATHS);
}

export async function deleteChargePolicyDraftAction(id: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => {
    await getContainer().chargePolicies.deleteDraft(ctx.companyId, { id: ctx.userId }, idOf(id, 'policy'));
    return { deleted: true };
  }, PATHS);
}

export async function activateChargePolicyAction(id: unknown, reason: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => summary(await getContainer().chargePolicies.activate(ctx.companyId, { id: ctx.userId }, idOf(id, 'policy'), reason)), PATHS);
}

export async function retireChargePolicyAction(id: unknown, reason: unknown) {
  return await runDelivery('delivery_rates:manage', async (ctx) => summary(await getContainer().chargePolicies.retire(ctx.companyId, { id: ctx.userId }, idOf(id, 'policy'), reason)), PATHS);
}

/** What the fees of a policy refer to, by zone, for showing a policy's rate card with names. */
export async function chargePolicyRateCountAction(id: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const policyId = idOf(id, 'policy');
    const [owned] = await drizzleDb.select({ id: chargePolicies.id }).from(chargePolicies).where(and(eq(chargePolicies.id, policyId), eq(chargePolicies.companyId, ctx.companyId)));
    if (owned === undefined) throw new DeliveryError('That policy could not be found.', 'NOT_FOUND');
    const [count] = await drizzleDb.select({ n: sql<number>`count(*)::int` }).from(chargePolicyRates).where(eq(chargePolicyRates.policyId, policyId));
    return { fees: count?.n ?? 0 };
  });
}

/** The company's base currency, KES when none is marked. */
async function baseCurrency(): Promise<string> {
  const [base] = await drizzleDb.select({ code: currencies.code }).from(currencies).where(eq(currencies.isBaseCurrency, true)).limit(1);
  return base?.code ?? 'KES';
}

/** The moment asked about: now when none is given; "2026-11-07T14:30" is that time in the business's time zone; a full timestamp is taken as it is. */
function moment(v: unknown): Date {
  if (typeof v !== 'string' || v.trim() === '') return new Date();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v.trim());
  if (m === null) return new Date(v);
  if (!isDateOnly(m[1] ?? '')) return new Date(Number.NaN);
  return new Date(startOfLocalDay(m[1] ?? '', DEFAULT_BUSINESS_TIMEZONE).getTime() + (Number(m[2]) * 60 + Number(m[3])) * 60_000);
}

const num = (v: unknown, what: string, fallback?: number): number => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (fallback !== undefined) return fallback;
    throw new DeliveryError(`${what} is needed.`, 'BAD_INPUT');
  }
  const n = typeof v === 'number' ? v : Number(typeof v === 'string' ? v.trim() : Number.NaN);
  if (!Number.isFinite(n) || n < 0) throw new DeliveryError(`${what} must be a number of zero or more.`, 'BAD_INPUT');
  return n;
};

/** What a delivery would cost, and why: the same pipeline an order uses, for any branch, address, pin, weight, value and time. */
export async function quoteDeliveryAction(raw: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const i = objectOf(raw);
    const branchId = idOf(i.branchId, 'branch');
    const at = moment(i.at);
    if (Number.isNaN(at.getTime())) throw new DeliveryError('The time is not valid.', 'BAD_INPUT');
    const hasPin = !(i.latitude === undefined || i.latitude === null || i.latitude === '') || !(i.longitude === undefined || i.longitude === null || i.longitude === '');
    let pin = null;
    if (hasPin) {
      const point = readGeoPoint(i.latitude, i.longitude);
      if (!point.ok) throw new DeliveryError(point.error, 'BAD_INPUT');
      pin = point.point;
    }
    const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 80) : null);
    const address = { county: word(i.county), town: word(i.town), area: word(i.area) };
    const groupId = typeof i.customerGroupId === 'string' && i.customerGroupId !== '' ? idOf(i.customerGroupId, 'customer group') : null;
    return await getContainer().deliveryQuotes.quote(ctx.companyId, {
      branchId,
      at,
      currency: typeof i.currency === 'string' && i.currency.trim() !== '' ? i.currency.trim().toUpperCase() : await baseCurrency(),
      channel: word(i.channel),
      customerGroupId: groupId,
      address,
      pin,
      weightKg: num(i.weightKg, 'The weight', 0),
      orderValue: num(i.orderValue, 'The order value', 0),
    });
  });
}

