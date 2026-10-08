'use server';

import { revalidatePath } from 'next/cache';
import { inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { CatalogService } from '@/server/domains/catalog/service';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import type { FloorExplanation, FloorRuleView } from './guard-config-service';
import type { FloorEnforcement, FloorScopeType, GuardTrace } from './domain/types';
import type { GuardLine } from './guard-service';
import type { PricingResult } from './actions';

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
    if (error instanceof AccessDeniedError)
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof PricingConfigError)
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    console.error('[price-guard]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const revalidate = () => revalidatePath('/admin/pricing', 'layout');
const config = () => getContainer().priceGuardConfig;

// ── Floors ───────────────────────────────────────────────────────────────────

export interface FloorsPageData {
  rules: FloorRuleView[];
  categories: Array<{ id: string; name: string; path: string; depth: number }>;
  brands: string[];
  groups: Array<{ id: string; code: string; name: string }>;
}

export async function getFloorsPageAction(): Promise<PricingResult<FloorsPageData>> {
  return run('pricing:read', async ({ companyId }) => {
    const [rules, categories, brands, groups] = await Promise.all([
      config().listFloorRules(companyId),
      CatalogService.getAllCategories(),
      config().brands(),
      config().listProductGroups(companyId),
    ]);
    return {
      rules,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        path: c.path ?? c.name,
        depth: c.depth ?? 0,
      })),
      brands,
      groups: groups
        .filter((g) => g.isActive)
        .map((g) => ({ id: g.id, code: g.code, name: g.name })),
    };
  });
}

export async function setFloorRuleAction(
  input: {
    scopeType: FloorScopeType;
    scopeRef?: string;
    markupPercent: number;
    enforcement?: FloorEnforcement;
    isActive?: boolean;
  },
  reason: Reason,
): Promise<PricingResult<FloorRuleView>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const row = await config().setFloorRule(companyId, input, actor, reason);
    revalidate();
    return row;
  });
}

export async function removeFloorRuleAction(
  id: string,
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().removeFloorRule(companyId, id, actor, reason);
    revalidate();
    return null;
  });
}

export async function explainFloorAction(
  productId: string,
): Promise<PricingResult<FloorExplanation>> {
  return run('pricing:read', ({ companyId }) => config().explainFloor(companyId, productId));
}

// ── Override limits ──────────────────────────────────────────────────────────

export async function getLimitsPageAction(): Promise<
  PricingResult<{
    limits: Awaited<ReturnType<ReturnType<typeof config>['listLimits']>>;
    roles: Array<{ key: string; name: string }>;
  }>
> {
  return run('pricing:read', async ({ companyId }) => ({
    limits: await config().listLimits(companyId),
    roles: await config().listRoles(),
  }));
}

export async function setLimitAction(
  input: { roleKey: string; maxPercent: number },
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().setLimit(companyId, input, actor, reason);
    revalidate();
    return null;
  });
}

export async function removeLimitAction(id: string, reason: Reason): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().removeLimit(companyId, id, actor, reason);
    revalidate();
    return null;
  });
}

// ── Product groups ───────────────────────────────────────────────────────────

export type ProductGroupView = Awaited<
  ReturnType<ReturnType<typeof config>['listProductGroups']>
>[number];

export async function listProductGroupsAction(): Promise<PricingResult<ProductGroupView[]>> {
  return run('pricing:read', ({ companyId }) => config().listProductGroups(companyId));
}

export async function saveProductGroupAction(
  input: {
    id?: string;
    code: string;
    name: string;
    description?: string | null;
    isActive?: boolean;
  },
  reason: Reason,
): Promise<PricingResult<{ id: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const row = await config().saveProductGroup(companyId, input, actor, reason);
    revalidate();
    return { id: row.id };
  });
}

export async function productGroupMembersAction(
  groupId: string,
  search?: string,
): Promise<PricingResult<Array<{ id: string; sku: string; name: string; cost: string }>>> {
  return run('pricing:read', ({ companyId }) => config().groupMembers(companyId, groupId, search));
}

export async function addProductGroupMembersAction(
  groupId: string,
  input: { productIds?: string[]; skus?: string[]; csv?: string },
  reason: Reason,
): Promise<PricingResult<{ added: number; alreadyIn: number }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    // A pasted list: SKUs separated by commas, spaces or new lines.
    const fromText = (input.csv ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const result = await config().addMembers(
      companyId,
      groupId,
      { productIds: input.productIds, skus: [...(input.skus ?? []), ...fromText] },
      actor,
      reason,
    );
    revalidate();
    return result;
  });
}

export async function removeProductGroupMembersAction(
  groupId: string,
  productIds: string[],
  reason: Reason,
): Promise<PricingResult<{ removed: number }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const result = await config().removeMembers(companyId, groupId, productIds, actor, reason);
    revalidate();
    return result;
  });
}

// ── Live check for a quote being typed ───────────────────────────────────────

/**
 * What the price floors and the person's override limit say about each line of a quote being
 * typed, so the screen can warn before saving. Saving checks again on the server.
 */
export async function previewQuoteGuardAction(input: {
  customerId?: string | null;
  paymentMethod?: string | null;
  quoteDiscountPercent?: number;
  lines: Array<{
    productId: string;
    quantity: number;
    /** The typed or saved unit price; absent for a line priced from the lists. */
    unitPrice?: number | null;
    discountPercent?: number;
  }>;
}): Promise<PricingResult<Array<GuardTrace | null>>> {
  return run('quotes:create', async ({ companyId, userId }) => {
    const { pricing, priceGuard, branches: branchRepo } = getContainer();
    if (input.lines.length === 0) return [];
    if (input.lines.length > 200)
      throw new PricingConfigError('TOO_MANY', 'Too many lines to check at once.');
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
    const usable = input.lines.map((l) => (byId.has(l.productId) && l.quantity > 0 ? l : null));
    const branch = await branchRepo.getDefault(companyId);
    const listed = await pricing.priceLines(
      companyId,
      {
        customerId: input.customerId || null,
        branchId: branch?.id ?? null,
        salesType: input.paymentMethod === 'on_account' ? 'credit' : 'cash',
        channel: 'sales_order',
      },
      usable.flatMap((l) => {
        if (!l) return [];
        const p = byId.get(l.productId)!;
        const inclusive = p.isTaxInclusive !== false;
        return [
          {
            productId: l.productId,
            quantity: l.quantity,
            standardPrice: p.price == null ? null : Number(p.price),
            taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
            lineTaxInclusive: inclusive,
            standardTaxInclusive: inclusive,
          },
        ];
      }),
    );
    // What the customer would pay with promotions: the reference an override is measured against.
    const usableLines = usable.flatMap((l) => (l ? [l] : []));
    const basket = await getContainer().discounts.evaluate(
      companyId,
      {
        customerId: input.customerId || null,
        branchId: branch?.id ?? null,
        salesType: input.paymentMethod === 'on_account' ? 'credit' : 'cash',
        channel: 'sales_order',
        paymentMethod: input.paymentMethod ?? null,
      },
      usableLines.flatMap((l, n) => {
        const r = listed[n]!;
        const p = byId.get(l.productId)!;
        return r.unitPrice == null || r.lineTotal == null
          ? []
          : [
              {
                productId: l.productId,
                quantity: l.quantity,
                unitPrice: r.unitPrice,
                lineTotal: r.lineTotal,
                taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
                lineTaxInclusive: p.isTaxInclusive !== false,
                explicitFloorUnit: r.trace.floorPrice ?? null,
                trace: r.trace,
              },
            ];
      }),
      { stages: { order: false } },
    );
    let withPrice = 0;
    const afterRules = listed.map((r) => (r.unitPrice == null ? null : basket.lines[withPrice++]!));
    let at = 0;
    const guardLines: Array<GuardLine | null> = usable.map((l) => {
      if (!l) return null;
      const p = byId.get(l.productId)!;
      const priced = listed[at]!;
      const after = afterRules[at++];
      const rate = p.taxRate == null ? 0 : Math.max(0, Number(p.taxRate));
      const toNet = (v: number) =>
        p.isTaxInclusive !== false && rate > 0 ? v / (1 + rate / 100) : v;
      const unit = l.unitPrice ?? after?.unitPriceAfter ?? priced.unitPrice;
      if (unit == null) return null;
      const lineDiscount = 1 - (l.discountPercent ?? 0) / 100;
      const quoteDiscount = 1 - (input.quoteDiscountPercent ?? 0) / 100;
      return {
        productId: l.productId,
        label: p.name,
        quantity: l.quantity,
        netUnit: toNet(unit * lineDiscount * quoteDiscount),
        overrideNetUnit: toNet(unit * lineDiscount),
        listNetUnit:
          (after?.unitPriceAfter ??
            priced.unitPrice ??
            (p.price == null ? null : Number(p.price))) == null
            ? null
            : toNet((after?.unitPriceAfter ?? priced.unitPrice ?? Number(p.price))!),
        explicitFloorNet: priced.trace.floorPrice != null ? toNet(priced.trace.floorPrice) : null,
      };
    });
    const verdict = await priceGuard.assess(
      companyId,
      userId,
      guardLines.filter((g): g is GuardLine => g != null),
    );
    let n = 0;
    return guardLines.map((g) => (g ? verdict.lines[n++]! : null));
  });
}
