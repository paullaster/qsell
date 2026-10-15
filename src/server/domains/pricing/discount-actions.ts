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
import type { CouponView, DiscountRuleView, SimulationResult } from './discount-config-service';
import type { DiscountRuleInput } from './domain/discount-rules';
import { checkDiscountRule } from './domain/discount-rules';
import type { MixConfig } from './domain/mix';
import type {
  DiscountConditions,
  DiscountKind,
  DiscountLimits,
  DiscountReward,
  DiscountSchedule,
  DiscountStatus,
  DiscountTarget,
  Stacking,
} from './domain/discounts';
import { NO_REWARD } from './domain/discounts';
import type { RuleIssue } from './domain/rules';
import { CHANNELS, SALES_TYPES, type Scopes } from './domain/types';
import type { PricingResult } from './actions';
import type { PricedItem } from './discount-service';
import { isMalformedId, NO_SUCH_RECORD } from '@/server/domains/settings/errors';

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
    if (isMalformedId(error)) return NO_SUCH_RECORD;
    console.error('[discounts]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const revalidate = () => {
  revalidatePath('/admin/pricing', 'layout');
  revalidatePath('/admin/approvals', 'layout');
};
const config = () => getContainer().discountConfig;

// ── Views ────────────────────────────────────────────────────────────────────

/** A rule as the screens see it: dates as text, nothing the browser cannot hold. */
export interface DiscountRuleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: DiscountKind;
  status: DiscountStatus;
  approvalStatus: string;
  version: number;
  priority: number;
  stacking: Stacking;
  validFrom: string;
  validTo: string | null;
  schedule: DiscountSchedule;
  scopes: Scopes;
  target: DiscountTarget;
  conditions: DiscountConditions;
  reward: DiscountReward;
  /** The deal, for a mix or gift rule. */
  mix: MixConfig | null;
  requiresCoupon: boolean;
  limits: DiscountLimits;
  strictLimits: boolean;
  appliesToContract: boolean;
  summary: string;
  uses: number;
  given: number;
  couponCount: number;
  updatedAt: string;
}

const toDto = (r: DiscountRuleView): DiscountRuleDto => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  kind: r.kind,
  status: r.status,
  approvalStatus: r.approvalStatus,
  version: r.version,
  priority: r.priority,
  stacking: r.stacking,
  validFrom: r.validFrom.toISOString(),
  validTo: r.validTo ? r.validTo.toISOString() : null,
  schedule: r.schedule,
  scopes: r.scopes,
  target: r.target,
  conditions: r.conditions,
  reward: r.reward ?? NO_REWARD,
  mix: r.mix ?? null,
  requiresCoupon: r.requiresCoupon,
  limits: r.limits,
  strictLimits: r.strictLimits,
  appliesToContract: r.appliesToContract,
  summary: r.summary,
  uses: r.uses,
  given: r.given,
  couponCount: r.couponCount,
  updatedAt: r.updatedAt.toISOString(),
});

export async function listDiscountRulesAction(): Promise<PricingResult<DiscountRuleDto[]>> {
  return run('pricing:read', async ({ companyId }) =>
    (await config().listRules(companyId)).map(toDto),
  );
}

export interface DiscountDetail {
  rule: DiscountRuleDto;
  /** What stops it going in force. */
  issues: RuleIssue[];
  /** Worth a second look; does not stop it. */
  warnings: RuleIssue[];
  /** Active rules that look like duplicates of this one. */
  overlaps: string[];
  coupons: CouponView[];
  recentUsage: Array<{
    documentType: string;
    documentId: string;
    kind: 'use' | 'reversal';
    amount: number;
    couponCode: string | null;
    occurredAt: string;
  }>;
  events: Array<{
    id: string;
    occurredAt: string;
    action: string;
    actorId: string | null;
    reasonCode: string | null;
    reasonText: string | null;
  }>;
}

export async function getDiscountRuleAction(id: string): Promise<PricingResult<DiscountDetail>> {
  return run('pricing:read', async ({ companyId }) => {
    const c = config();
    const [view, issues, coupons, usage, events, overlaps] = await Promise.all([
      c.getRuleView(companyId, id),
      c.activationIssues(companyId, id),
      c.listCoupons(companyId, id),
      c.recentUsage(companyId, id),
      c.timeline(id),
      c.overlaps(companyId, id),
    ]);
    const row = await c.getRule(companyId, id);
    const checks = checkDiscountRule({
      code: row.code,
      name: row.name,
      kind: row.kind,
      priority: row.priority,
      stacking: row.stacking,
      validFrom: row.validFrom,
      validTo: row.validTo,
      schedule: row.schedule,
      scopes: row.scopes,
      target: row.target,
      conditions: row.conditions,
      reward: row.reward ?? NO_REWARD,
      mix: row.mix,
      requiresCoupon: row.requiresCoupon,
      limits: row.limits,
    });
    return {
      rule: toDto(view),
      issues,
      warnings: checks.warnings,
      overlaps,
      coupons,
      recentUsage: usage.map((u) => ({
        documentType: u.documentType,
        documentId: u.documentId,
        kind: u.kind,
        amount: Number(u.amount),
        couponCode: u.couponCode,
        occurredAt: u.occurredAt.toISOString(),
      })),
      events: events.map((e) => ({
        id: e.id,
        occurredAt: e.occurredAt.toISOString(),
        action: e.action,
        actorId: e.actorId,
        reasonCode: e.reasonCode,
        reasonText: e.reasonText,
      })),
    };
  });
}

export interface DiscountLookups {
  categories: Array<{ id: string; name: string; path: string; depth: number }>;
  brands: string[];
  productGroups: Array<{ id: string; code: string; name: string }>;
  customerGroups: Array<{ id: string; code: string; name: string }>;
  branches: Array<{ id: string; code: string; name: string }>;
  channels: readonly string[];
  salesTypes: readonly string[];
  paymentMethods: Array<{ code: string; label: string }>;
}

const PAYMENT_METHODS = [
  { code: 'on_account', label: 'On account (credit)' },
  { code: 'mpesa_daraja', label: 'M-Pesa' },
  { code: 'card_direct', label: 'Card' },
  { code: 'pesapal_v3', label: 'Pesapal' },
  { code: 'jenga_hq', label: 'Jenga' },
  { code: 'kcb_buni', label: 'KCB Buni' },
];

export async function getDiscountLookupsAction(): Promise<PricingResult<DiscountLookups>> {
  return run('pricing:read', async ({ companyId }) => {
    const { priceGuardConfig, pricingConfig, branches: branchRepo } = getContainer();
    const [cats, brands, groups, customerGroups, branches] = await Promise.all([
      CatalogService.getAllCategories(),
      priceGuardConfig.brands(),
      priceGuardConfig.listProductGroups(companyId),
      pricingConfig.listGroups(companyId),
      branchRepo.listByCompany(companyId),
    ]);
    return {
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        path: c.path ?? c.name,
        depth: c.depth ?? 0,
      })),
      brands,
      productGroups: groups
        .filter((g) => g.isActive)
        .map((g) => ({ id: g.id, code: g.code, name: g.name })),
      customerGroups: customerGroups
        .filter((g) => g.isActive)
        .map((g) => ({ id: g.id, code: g.code, name: g.name })),
      branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      channels: CHANNELS,
      salesTypes: SALES_TYPES,
      paymentMethods: PAYMENT_METHODS,
    };
  });
}

// ── Changing rules ───────────────────────────────────────────────────────────

/** What the form sends. Dates are text so they cross the network. */
export interface DiscountFormInput {
  code: string;
  name: string;
  description?: string | null;
  kind: DiscountKind;
  priority: number;
  stacking: Stacking;
  validFrom: string;
  validTo: string | null;
  schedule: DiscountSchedule;
  scopes: Scopes;
  target: DiscountTarget;
  conditions: DiscountConditions;
  reward: DiscountReward;
  mix?: MixConfig | null;
  requiresCoupon: boolean;
  limits: DiscountLimits;
  strictLimits?: boolean;
  appliesToContract?: boolean;
}

const toInput = (f: DiscountFormInput): DiscountRuleInput => ({
  code: f.code,
  name: f.name,
  kind: f.kind,
  priority: f.priority,
  stacking: f.stacking,
  validFrom: new Date(f.validFrom),
  validTo: f.validTo ? new Date(f.validTo) : null,
  schedule: f.schedule,
  scopes: f.scopes,
  target: f.target,
  conditions: f.conditions,
  reward: f.reward,
  mix: f.mix ?? null,
  requiresCoupon: f.requiresCoupon,
  limits: f.limits,
});

/** Checks a rule as it is being filled in, without saving it. */
export async function checkDiscountRuleAction(
  form: DiscountFormInput,
): Promise<PricingResult<{ errors: RuleIssue[]; warnings: RuleIssue[] }>> {
  return run('pricing:read', ({ companyId }) => config().check(companyId, toInput(form)));
}

export async function saveDiscountRuleAction(
  form: DiscountFormInput,
  reason: Reason,
  id?: string,
): Promise<PricingResult<{ id: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const input = toInput(form);
    const extra = {
      strictLimits: form.strictLimits,
      appliesToContract: form.appliesToContract,
      description: form.description ?? null,
    };
    let row;
    if (id) {
      const { code: _c, kind: _k, ...patch } = input;
      row = await config().updateRule(companyId, id, { ...patch, ...extra }, actor, reason);
    } else {
      row = await config().createRule(companyId, { ...input, ...extra }, actor, reason);
    }
    revalidate();
    return { id: row.id };
  });
}

export async function activateDiscountRuleAction(
  id: string,
  reason: Reason,
): Promise<PricingResult<{ pending: boolean; message?: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const r = await config().requestActivation(companyId, id, actor, reason);
    revalidate();
    return r.outcome === 'active' ? { pending: false } : { pending: true, message: r.message };
  });
}

export async function pauseDiscountRuleAction(
  id: string,
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().pause(companyId, id, actor, reason);
    revalidate();
    return null;
  });
}

export async function retireDiscountRuleAction(
  id: string,
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().retire(companyId, id, actor, reason);
    revalidate();
    return null;
  });
}

// ── Coupons ──────────────────────────────────────────────────────────────────

export async function createCouponsAction(
  ruleId: string,
  input: {
    codes?: string[];
    generate?: { count: number; prefix?: string; length?: number };
    validFrom?: string | null;
    validTo?: string | null;
    maxUses?: number | null;
    maxUsesPerCustomer?: number | null;
  },
  reason: Reason,
): Promise<PricingResult<{ created: string[] }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const r = await config().createCoupons(
      companyId,
      ruleId,
      {
        ...input,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validTo: input.validTo ? new Date(input.validTo) : null,
      },
      actor,
      reason,
    );
    revalidate();
    return r;
  });
}

export async function setCouponStatusAction(
  couponId: string,
  status: 'active' | 'disabled',
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await config().setCouponStatus(companyId, couponId, status, actor, reason);
    revalidate();
    return null;
  });
}

// ── Trying it ────────────────────────────────────────────────────────────────

/** Prices a basket as a sale would be, discounts included, and says why each rule did or did not apply. */
export async function simulateDiscountsAction(input: {
  customerId?: string | null;
  channel?: string;
  salesType?: string;
  paymentMethod?: string | null;
  couponCodes?: string[];
  at?: string | null;
  tryRuleId?: string | null;
  lines: Array<{ productId: string; quantity: number }>;
}): Promise<PricingResult<SimulationResult>> {
  return run('pricing:read', ({ companyId }) =>
    config().simulate(companyId, {
      ...input,
      at: input.at ? new Date(input.at) : undefined,
      tryRuleId: input.tryRuleId ?? undefined,
    }),
  );
}

/**
 * For the quote editor: what order rules and coupons would take off the quote as typed. Needs
 * only the right to write quotes; saving works it out again on the server.
 */
export async function previewQuoteDiscountsAction(input: {
  customerId?: string | null;
  paymentMethod?: string | null;
  couponCodes?: string[];
  lines: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
    discountPercent?: number;
  }>;
}): Promise<
  PricingResult<{
    applied: Array<{
      code: string;
      name: string;
      amount: number;
      how: string;
      couponCode?: string;
    }>;
    couponProblems: Array<{ code: string; reason: string }>;
    gifts: Array<{ code: string; name: string; quantity: number; value: number }>;
    total: number;
  }>
> {
  return run('quotes:create', async ({ companyId }) => {
    const { discounts, branches: branchRepo } = getContainer();
    if (input.lines.length === 0 || input.lines.length > 200)
      return { applied: [], couponProblems: [], gifts: [], total: 0 };
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
    const items: PricedItem[] = input.lines.flatMap((l) => {
      const p = byId.get(l.productId);
      if (!p || !(l.quantity > 0) || !Number.isFinite(l.unitPrice)) return [];
      const unit = l.unitPrice * (1 - Math.min(100, Math.max(0, l.discountPercent ?? 0)) / 100);
      return [
        {
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: unit,
          lineTotal: unit * l.quantity,
          taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
          lineTaxInclusive: p.isTaxInclusive !== false,
        },
      ];
    });
    const basket = await discounts.evaluate(
      companyId,
      {
        customerId: input.customerId || null,
        branchId: branch?.id ?? null,
        salesType: input.paymentMethod === 'on_account' ? 'credit' : 'cash',
        channel: 'sales_order',
        paymentMethod: input.paymentMethod ?? null,
      },
      items,
      { couponCodes: input.couponCodes, stages: { line: false } },
    );
    return {
      applied: basket.orderApplied.map((a) => ({
        code: a.code,
        name: a.name,
        amount: a.amount,
        how: a.how,
        couponCode: a.couponCode,
      })),
      couponProblems: basket.couponProblems,
      gifts: basket.gifts.map((g) => ({
        code: g.code,
        name: g.productName,
        quantity: g.quantity,
        value: g.value,
      })),
      total: basket.totalDiscount,
    };
  });
}
