'use server';

import { revalidatePath } from 'next/cache';
import { eq, inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  currencies,
  customerGroups,
  customers,
  products,
} from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { PricingConfigError, type Gated, type LineInput } from './config-service';
import { describeScopes, type RuleIssue } from './domain/rules';
import {
  CHANNELS,
  SALES_TYPES,
  type PriceListKind,
  type PriceListStatus,
  type PriceResult,
  type QuantityMode,
  type Scopes,
  type SpecificityWeights,
  type Tier,
} from './domain/types';

export type PricingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; issues?: RuleIssue[]; forbidden?: true };

type Reason = { code: string; text?: string };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  permission: PermissionKey,
  fn: (ctx: {
    companyId: string;
    userId: string;
    actor: { type: 'user'; id: string };
  }) => Promise<T>,
): Promise<PricingResult<T>> {
  try {
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    return {
      ok: true,
      data: await fn({ companyId: company.id, userId, actor: { type: 'user', id: userId } }),
    };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    }
    if (error instanceof PricingConfigError) {
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    }
    if (error instanceof ReasonError) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error('[pricing]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const revalidate = () => revalidatePath('/admin/pricing', 'layout');
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const num = (v: string | null) => (v == null ? null : Number(v));

// ── Views ────────────────────────────────────────────────────────────────────

export interface PriceListView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: PriceListKind;
  currency: string;
  taxInclusive: boolean;
  quantityMode: QuantityMode;
  priority: number;
  validFrom: string;
  validTo: string | null;
  scopes: Scopes;
  scopeText: string;
  status: PriceListStatus;
  approvalStatus: string;
  version: number;
  lineCount: number;
  updatedAt: string;
}

type NameMap = Partial<Record<string, Record<string, string>>>;

/** Names for the customers, groups and branches that lists are limited to. */
const scopeNames = (lists: Array<{ scopes: Scopes }>): Promise<NameMap> =>
  getContainer().pricingConfig.scopeNames(lists);

function toView(
  row: Awaited<ReturnType<ReturnType<typeof getContainer>['pricingConfig']['getList']>>,
  lineCount: number,
  names: NameMap,
): PriceListView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    currency: row.currency,
    taxInclusive: row.taxInclusive,
    quantityMode: row.quantityMode,
    priority: row.priority,
    validFrom: row.validFrom.toISOString(),
    validTo: iso(row.validTo),
    scopes: row.scopes ?? {},
    scopeText: describeScopes(row.scopes ?? {}, names),
    status: row.status,
    approvalStatus: row.approvalStatus,
    version: row.version,
    lineCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPriceListsAction(): Promise<PricingResult<PriceListView[]>> {
  return run('pricing:read', async ({ companyId }) => {
    const rows = await getContainer().pricingConfig.listLists(companyId);
    const names = await scopeNames(rows);
    return rows.map((r) => toView(r, r.lineCount, names));
  });
}

export interface PriceListDetail {
  list: PriceListView;
  /** What stops it going live, in words. Empty when it can. */
  issues: RuleIssue[];
  /** Names for the customers, groups and branches the list is limited to. */
  names: NameMap;
  timeline: Array<{
    at: string;
    action: string;
    actor: string | null;
    reason: string | null;
    detail: string;
  }>;
}

const DETAIL_KEYS: Record<string, (o: Record<string, unknown>) => string> = {
  'pricing.prices_changed': (o) =>
    `${o.created ?? 0} added, ${o.replaced ?? 0} changed, ${o.unchanged ?? 0} already as given`,
  'pricing.prices_removed': (o) => `${o.removed ?? 0} removed`,
  'pricing.list_changed': (o) => Object.keys(o).join(', '),
  'pricing.group_members_changed': (o) => `${o.added ?? 0} added, ${o.removed ?? 0} removed`,
};

export async function getPriceListAction(id: string): Promise<PricingResult<PriceListDetail>> {
  return run('pricing:read', async ({ companyId }) => {
    const { pricingConfig } = getContainer();
    const row = await pricingConfig.getList(companyId, id);
    const [lists, issues, events] = await Promise.all([
      pricingConfig.listLists(companyId),
      row.status === 'retired'
        ? Promise.resolve([])
        : pricingConfig.activationIssues(companyId, id),
      pricingConfig.timeline(id),
    ]);
    const names = await scopeNames([row]);
    const count = lists.find((l) => l.id === id)?.lineCount ?? 0;
    return {
      list: toView(row, count, names),
      issues: row.status === 'active' ? [] : issues,
      names,
      timeline: events.map((e) => ({
        at: e.occurredAt.toISOString(),
        action: e.action,
        actor: e.actorId,
        reason: [e.reasonCode, e.reasonText].filter(Boolean).join(': ') || null,
        detail: DETAIL_KEYS[e.action]?.((e.outcome ?? {}) as Record<string, unknown>) ?? '',
      })),
    };
  });
}

export interface PriceLineView {
  id: string;
  productId: string;
  name: string;
  sku: string;
  standardPrice: number | null;
  price: number;
  tiers: Tier[];
  floorPrice: number | null;
  lockedUntil: string | null;
  validFrom: string;
}

export async function listPriceLinesAction(
  id: string,
  opts: { search?: string; page?: number } = {},
): Promise<
  PricingResult<{ rows: PriceLineView[]; total: number; page: number; pageSize: number }>
> {
  return run('pricing:read', async ({ companyId }) => {
    const r = await getContainer().pricingConfig.listLines(companyId, id, {
      ...opts,
      pageSize: 50,
    });
    return {
      ...r,
      rows: r.rows.map(({ line, name, sku, standardPrice }) => ({
        id: line.id,
        productId: line.productId,
        name,
        sku,
        standardPrice: num(standardPrice),
        price: Number(line.price),
        tiers: (line.tiers ?? []).map((t) => ({
          fromQty: Number(t.fromQty),
          price: Number(t.price),
        })),
        floorPrice: num(line.floorPrice),
        lockedUntil: iso(line.lockedUntil),
        validFrom: line.validFrom.toISOString(),
      })),
    };
  });
}

export async function priceHistoryAction(
  id: string,
  productId: string,
): Promise<
  PricingResult<
    Array<{
      validFrom: string;
      validTo: string | null;
      price: number;
      by: string;
      reason: string | null;
    }>
  >
> {
  return run('pricing:read', async ({ companyId }) =>
    (await getContainer().pricingConfig.lineHistory(companyId, id, productId)).map((h) => ({
      validFrom: h.validFrom.toISOString(),
      validTo: iso(h.validTo),
      price: Number(h.price),
      by: h.createdBy,
      reason: h.reasonCode,
    })),
  );
}

// ── Reasons and lookups ──────────────────────────────────────────────────────

export async function listPricingReasonsAction(): Promise<
  PricingResult<{ code: string; description: string; requiresComment: boolean }[]>
> {
  return run('pricing:read', async ({ companyId }) =>
    (await getContainer().reasonCodes.list(companyId))
      .filter(
        (r) =>
          r.isActive && (r.appliesTo.length === 0 || r.appliesTo.includes('pricing_configuration')),
      )
      .map((r) => ({
        code: r.code,
        description: r.description,
        requiresComment: r.requiresComment,
      })),
  );
}

export interface PricingLookups {
  branches: Array<{ id: string; code: string; name: string }>;
  currencies: Array<{ code: string; name: string; isBase: boolean }>;
  groups: Array<{ id: string; code: string; name: string }>;
  channels: readonly string[];
  salesTypes: readonly string[];
  baseCurrency: string;
}

export async function getPricingLookupsAction(): Promise<PricingResult<PricingLookups>> {
  return run('pricing:read', async ({ companyId }) => {
    const { pricingConfig, branches: branchRepo } = getContainer();
    const [branchRows, currencyRows, groups] = await Promise.all([
      branchRepo.listByCompany(companyId),
      drizzleDb.select().from(currencies).where(eq(currencies.isEnabled, true)),
      pricingConfig.listGroups(companyId),
    ]);
    return {
      branches: branchRows.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      currencies: currencyRows.map((c) => ({
        code: c.code,
        name: c.name,
        isBase: c.isBaseCurrency,
      })),
      groups: groups
        .filter((g) => g.isActive)
        .map((g) => ({ id: g.id, code: g.code, name: g.name })),
      channels: CHANNELS,
      salesTypes: SALES_TYPES,
      baseCurrency: currencyRows.find((c) => c.isBaseCurrency)?.code ?? 'KES',
    };
  });
}

export async function searchCustomersAction(
  q: string,
): Promise<PricingResult<Array<{ id: string; number: string; name: string }>>> {
  return run('pricing:read', ({ companyId }) =>
    getContainer().pricingConfig.searchCustomers(companyId, q),
  );
}

export async function searchProductsAction(
  q: string,
): Promise<PricingResult<Array<{ id: string; name: string; sku: string; price: string | null }>>> {
  return run('pricing:read', () => getContainer().pricingConfig.searchProducts(q));
}

// ── Price lists: changes ─────────────────────────────────────────────────────

export interface PriceListFormInput {
  code: string;
  name: string;
  description?: string | null;
  kind: PriceListKind;
  currency: string;
  taxInclusive: boolean;
  quantityMode: QuantityMode;
  priority: number;
  validFrom?: string | null;
  validTo?: string | null;
  scopes: Scopes;
}

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

export async function createPriceListAction(
  input: PriceListFormInput,
  reason: Reason,
): Promise<PricingResult<{ id: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const row = await getContainer().pricingConfig.createList(
      companyId,
      { ...input, validFrom: date(input.validFrom), validTo: date(input.validTo) },
      actor,
      reason,
    );
    revalidate();
    return { id: row.id };
  });
}

export async function updatePriceListAction(
  id: string,
  patch: Partial<Omit<PriceListFormInput, 'code' | 'currency' | 'kind'>>,
  reason: Reason,
): Promise<PricingResult<Gated<{ version: number }>>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const { validFrom, validTo, ...rest } = patch;
    const row = await getContainer().pricingConfig.updateListGated(
      companyId,
      id,
      {
        ...rest,
        ...(validFrom !== undefined ? { validFrom: date(validFrom) } : {}),
        ...(validTo !== undefined ? { validTo: date(validTo) } : {}),
      },
      actor,
      reason,
    );
    revalidate();
    return row;
  });
}

export async function activatePriceListAction(
  id: string,
  reason: Reason,
): Promise<
  PricingResult<
    | { status: PriceListStatus; pending: false }
    | { status: PriceListStatus; pending: true; message: string }
  >
> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    // Goes live now, or is held for the approvers when a workflow applies to price lists.
    const result = await getContainer().pricingConfig.requestActivation(
      companyId,
      id,
      actor,
      reason,
    );
    revalidate();
    revalidatePath('/admin/approvals', 'layout');
    return result.outcome === 'active'
      ? { status: 'active' as const, pending: false as const }
      : { status: 'draft' as const, pending: true as const, message: result.message };
  });
}

export async function retirePriceListAction(
  id: string,
  reason: Reason,
): Promise<PricingResult<{ status: PriceListStatus; pending: false }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const row = await getContainer().pricingConfig.retire(companyId, id, actor, reason);
    revalidate();
    return { status: row.status, pending: false as const };
  });
}

export async function savePriceLinesAction(
  id: string,
  rows: Array<{
    productId: string;
    price: number;
    tiers?: Tier[];
    floorPrice?: number | null;
    lockedUntil?: string | null;
  }>,
  reason: Reason,
  opts: { validFrom?: string | null; overrideLock?: boolean } = {},
): Promise<PricingResult<Gated<{ created: number; replaced: number; unchanged: number }>>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const result = await getContainer().pricingConfig.setLinesGated(
      companyId,
      id,
      rows.map<LineInput>((r) => ({ ...r, lockedUntil: date(r.lockedUntil) })),
      actor,
      reason,
      { validFrom: date(opts.validFrom) ?? undefined, overrideLock: opts.overrideLock },
    );
    revalidate();
    return result;
  });
}

export async function removePriceLinesAction(
  id: string,
  productIds: string[],
  reason: Reason,
  opts: { overrideLock?: boolean } = {},
): Promise<PricingResult<Gated<{ removed: number }>>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const result = await getContainer().pricingConfig.removeLinesGated(
      companyId,
      id,
      productIds,
      actor,
      reason,
      opts,
    );
    revalidate();
    return result;
  });
}

/**
 * Reads a pasted or uploaded file of `sku, price, floor price, breaks` ("50:90;100:85") and sets
 * those prices. Either every row is valid and all are applied, or none are and each bad row is named.
 */
export async function importPriceLinesAction(
  id: string,
  csv: string,
  reason: Reason,
  opts: { validFrom?: string | null; overrideLock?: boolean } = {},
): Promise<PricingResult<Gated<{ created: number; replaced: number; unchanged: number }>>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const first = lines[0]?.split(',')[0]?.trim().toLowerCase();
    const body = first === 'sku' ? lines.slice(1) : lines;
    const issues: RuleIssue[] = [];
    const parsed: Array<{
      sku: string;
      price: number;
      floor: number | null;
      tiers: Tier[];
      row: number;
    }> = [];
    body.forEach((line, i) => {
      const row = i + (first === 'sku' ? 2 : 1);
      const [sku = '', price = '', floor = '', breaks = ''] = line.split(',').map((c) => c.trim());
      const p = Number(price);
      if (!sku)
        return void issues.push({ path: `row ${row}`, message: `Row ${row}: the SKU is missing.` });
      if (price === '' || !Number.isFinite(p) || p < 0)
        return void issues.push({
          path: `row ${row}`,
          message: `Row ${row}: "${price}" is not a price.`,
        });
      let floorPrice: number | null = null;
      if (floor !== '') {
        floorPrice = Number(floor);
        if (!Number.isFinite(floorPrice) || floorPrice < 0)
          return void issues.push({
            path: `row ${row}`,
            message: `Row ${row}: "${floor}" is not a floor price.`,
          });
      }
      const tiers: Tier[] = [];
      for (const part of breaks.split(';').filter(Boolean)) {
        const [q, tp] = part.split(':').map((x) => Number(x));
        if (!Number.isFinite(q) || !Number.isFinite(tp))
          return void issues.push({
            path: `row ${row}`,
            message: `Row ${row}: a quantity break reads "50:90" (from 50 units, price 90).`,
          });
        tiers.push({ fromQty: q!, price: tp! });
      }
      parsed.push({ sku, price: p, floor: floorPrice, tiers, row });
    });
    if (parsed.length === 0 && issues.length === 0)
      throw new PricingConfigError('INVALID', 'The file has no prices in it.');
    const skus = [...new Set(parsed.map((p) => p.sku))];
    const found = skus.length
      ? await drizzleDb
          .select({ id: products.id, sku: products.sku })
          .from(products)
          .where(inArray(products.sku, skus))
      : [];
    const bySku = new Map(found.map((p) => [p.sku.toLowerCase(), p.id]));
    for (const p of parsed) {
      if (!bySku.has(p.sku.toLowerCase()))
        issues.push({
          path: `row ${p.row}`,
          message: `Row ${p.row}: no product has the SKU "${p.sku}".`,
        });
    }
    if (issues.length) {
      throw new PricingConfigError(
        'INVALID',
        `${issues.length} row${issues.length === 1 ? '' : 's'} could not be read. Nothing was changed.`,
        issues.slice(0, 20),
      );
    }
    const result = await getContainer().pricingConfig.setLinesGated(
      companyId,
      id,
      parsed.map((p) => ({
        productId: bySku.get(p.sku.toLowerCase())!,
        price: p.price,
        floorPrice: p.floor,
        tiers: p.tiers,
      })),
      actor,
      reason,
      { validFrom: date(opts.validFrom) ?? undefined, overrideLock: opts.overrideLock },
    );
    revalidate();
    return result;
  });
}

// ── Customer groups ──────────────────────────────────────────────────────────

export interface CustomerGroupView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  memberCount: number;
}

export async function listCustomerGroupsAction(): Promise<PricingResult<CustomerGroupView[]>> {
  return run('pricing:read', async ({ companyId }) =>
    (await getContainer().pricingConfig.listGroups(companyId)).map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      description: g.description,
      priority: g.priority,
      isActive: g.isActive,
      memberCount: g.memberCount,
    })),
  );
}

export async function saveCustomerGroupAction(
  input: {
    id?: string;
    code: string;
    name: string;
    description?: string | null;
    priority: number;
    isActive: boolean;
  },
  reason: Reason,
): Promise<PricingResult<{ id: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const row = await getContainer().pricingConfig.saveGroup(companyId, input, actor, reason);
    revalidate();
    return { id: row.id };
  });
}

export async function customerGroupMembersAction(
  groupId: string,
  search?: string,
): Promise<
  PricingResult<Array<{ id: string; number: string; name: string; email: string | null }>>
> {
  return run('pricing:read', ({ companyId }) =>
    getContainer().pricingConfig.groupMembers(companyId, groupId, search),
  );
}

export async function changeGroupMembersAction(
  groupId: string,
  change: { add?: string[]; remove?: string[] },
  reason: Reason,
): Promise<PricingResult<{ added: number; removed: number }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const r = await getContainer().pricingConfig.changeMembers(
      companyId,
      groupId,
      change,
      actor,
      reason,
    );
    revalidate();
    return r;
  });
}

// ── Rules (weights) ──────────────────────────────────────────────────────────

export async function getWeightsAction(): Promise<PricingResult<SpecificityWeights>> {
  return run('pricing:read', ({ companyId }) => getContainer().pricingConfig.getWeights(companyId));
}

export async function setWeightsAction(
  patch: Partial<SpecificityWeights>,
  reason: Reason,
): Promise<PricingResult<SpecificityWeights>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const r = await getContainer().pricingConfig.setWeights(companyId, patch, actor, reason);
    revalidate();
    return r;
  });
}

export async function resetWeightsAction(
  reason: Reason,
): Promise<PricingResult<SpecificityWeights>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await getContainer().pricingConfig.resetWeights(companyId, actor, reason);
    revalidate();
    return getContainer().pricingConfig.getWeights(companyId);
  });
}

// ── Price check (the simulator) ──────────────────────────────────────────────

export interface PriceCheckInput {
  productId: string;
  quantity: number;
  customerId?: string | null;
  branchId?: string | null;
  salesType?: string | null;
  channel?: string | null;
  route?: string | null;
  country?: string | null;
  currency?: string | null;
  /** ISO date-time; defaults to now. */
  at?: string | null;
}

export interface PriceCheckResult {
  product: { id: string; name: string; sku: string; standardPrice: number | null };
  result: PriceResult;
  /** The winning group of the customer, if any, by name. */
  groupName: string | null;
}

/** Runs the real engine without saving anything: the answer is the answer an order would get. */
export async function checkPriceAction(
  input: PriceCheckInput,
): Promise<PricingResult<PriceCheckResult>> {
  return run('pricing:read', async ({ companyId }) => {
    const { pricing } = getContainer();
    const [p] = await drizzleDb
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!p || p.deletedAt)
      throw new PricingConfigError('NOT_FOUND', 'That product does not exist.');
    const inclusive = p.isTaxInclusive !== false;
    const sale = {
      customerId: input.customerId || null,
      branchId: input.branchId || null,
      salesType: input.salesType || null,
      channel: input.channel || null,
      route: input.route || null,
      country: input.country || null,
      currency: input.currency || null,
      at: input.at ? new Date(input.at) : undefined,
    };
    const [result] = await pricing.priceLines(companyId, sale, [
      {
        productId: p.id,
        quantity: Number(input.quantity),
        standardPrice: p.price == null ? null : Number(p.price),
        taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
        lineTaxInclusive: inclusive,
        standardTaxInclusive: inclusive,
      },
    ]);
    const groupId = result!.trace.inputs.customerGroupId;
    const groupName = groupId
      ? ((
          await drizzleDb
            .select({ name: customerGroups.name })
            .from(customerGroups)
            .where(eq(customerGroups.id, groupId))
            .limit(1)
        )[0]?.name ?? null)
      : null;
    return {
      product: {
        id: p.id,
        name: p.name,
        sku: p.sku,
        standardPrice: p.price == null ? null : Number(p.price),
      },
      result: result!,
      groupName,
    };
  });
}

/**
 * Prices the lines of a quote being typed, so the screen shows the price the save will use. Needs
 * only the right to write quotes; saving still prices on the server.
 */
export async function previewQuotePricesAction(input: {
  customerId?: string | null;
  paymentMethod?: string | null;
  lines: Array<{ productId: string; quantity: number }>;
}): Promise<PricingResult<Array<{ unitPrice: number | null; trace: PriceResult['trace'] }>>> {
  return run('quotes:create', async ({ companyId }) => {
    const { pricing, branches: branchRepo } = getContainer();
    if (input.lines.length === 0) return [];
    if (input.lines.length > 200)
      throw new PricingConfigError('TOO_MANY', 'Too many lines to price at once.');
    const rows = await drizzleDb
      .select()
      .from(products)
      .where(
        inArray(
          products.id,
          input.lines.map((l) => l.productId),
        ),
      );
    const byId = new Map(rows.map((p) => [p.id, p]));
    const branch = await branchRepo.getDefault(companyId);
    const lines = input.lines.filter((l) => byId.has(l.productId) && l.quantity > 0);
    const results = await pricing.priceLines(
      companyId,
      {
        customerId: input.customerId || null,
        branchId: branch?.id ?? null,
        salesType: input.paymentMethod === 'on_account' ? 'credit' : 'cash',
        channel: 'sales_order',
      },
      lines.map((l) => {
        const p = byId.get(l.productId)!;
        const inclusive = p.isTaxInclusive !== false;
        return {
          productId: l.productId,
          quantity: l.quantity,
          standardPrice: p.price == null ? null : Number(p.price),
          taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
          lineTaxInclusive: inclusive,
          standardTaxInclusive: inclusive,
        };
      }),
    );
    // Answers line for line, in the order asked.
    const answered = new Map(lines.map((l, i) => [l, results[i]!]));
    return input.lines.map((l) => {
      const r = answered.get(l);
      return r
        ? { unitPrice: r.unitPrice, trace: r.trace }
        : {
            unitPrice: null,
            trace: { ...emptyTrace(l.productId), steps: ['This line cannot be priced.'] },
          };
    });
  });
}

function emptyTrace(productId: string): PriceResult['trace'] {
  return {
    engineVersion: 1,
    at: new Date().toISOString(),
    inputs: { productId, quantity: 0, currency: '' },
    candidates: [],
    steps: [],
    source: 'none',
    unitPrice: null,
    lineTotal: null,
  };
}
