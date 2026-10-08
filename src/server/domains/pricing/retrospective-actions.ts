'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { orderTenders, orders } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { amountDue } from '@/server/domains/orders/amount-due';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import type { PricingResult } from './actions';
import { PricingConfigError } from './config-service';
import type { DiscountTarget } from './domain/discounts';
import type { LoyaltyConfig } from './domain/loyalty';
import type { RebatePeriod, RebateTier, TierMode } from './domain/rebate';
import { checkRebateProgram, checkLoyaltyFor } from './retrospective-checks';
import type { RuleIssue } from './domain/rules';
import type { Scopes } from './domain/types';
import type { GiftCardDetail, GiftCardView } from './giftcard-service';
import type { LoyaltyAccountView, LoyaltyProgramView } from './loyalty-service';
import type { Statement } from './rebate-config-service';
import type { TenderInput, TenderResult } from './tender-service';

type Reason = { code: string; text?: string };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  permission: PermissionKey,
  fn: (ctx: { companyId: string; actor: { type: 'user'; id: string } }) => Promise<T>,
): Promise<PricingResult<T>> {
  try {
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    return {
      ok: true,
      data: await fn({ companyId: company.id, actor: { type: 'user', id: userId } }),
    };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError)
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof PricingConfigError)
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    console.error('[retrospective]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const revalidate = () => revalidatePath('/admin/pricing', 'layout');

// ── Rebates ──────────────────────────────────────────────────────────────────

export interface RebateDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'retired';
  version: number;
  period: RebatePeriod;
  tierMode: TierMode;
  tiers: RebateTier[];
  scopes: Scopes;
  target: DiscountTarget;
  validFrom: string;
  validTo: string | null;
  summary: string;
  current: { key: string; label: string; customers: number; basis: number };
}

export interface RebateFormInput {
  code: string;
  name: string;
  description?: string | null;
  period: RebatePeriod;
  tierMode: TierMode;
  tiers: RebateTier[];
  scopes: Scopes;
  target: DiscountTarget;
  validFrom: string;
  validTo: string | null;
}

const toInput = (f: RebateFormInput) => ({
  code: f.code,
  name: f.name,
  description: f.description ?? null,
  period: f.period,
  tierMode: f.tierMode,
  tiers: f.tiers,
  scopes: f.scopes,
  target: f.target,
  validFrom: new Date(f.validFrom),
  validTo: f.validTo ? new Date(f.validTo) : null,
});

export async function listRebatesAction(): Promise<PricingResult<RebateDto[]>> {
  return run('pricing:read', async ({ companyId }) =>
    (await getContainer().rebateConfig.list(companyId)).map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      status: r.status,
      version: r.version,
      period: r.period,
      tierMode: r.tierMode,
      tiers: r.tiers,
      scopes: r.scopes,
      target: r.target,
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo?.toISOString() ?? null,
      summary: r.summary,
      current: r.current,
    })),
  );
}

export interface RebateDetail {
  program: RebateDto;
  periods: Array<{ key: string; label: string; ended: boolean }>;
  settlements: Array<{
    id: string;
    customerName: string;
    periodKey: string;
    amount: number;
    status: string;
    creditRef: string | null;
    createdAt: string;
  }>;
  timeline: Array<{ action: string; actor: string | null; at: string; reason: string | null }>;
  /** Names for the products, categories and groups it covers, for editing. */
  names: Record<string, string>;
}

export async function getRebateAction(id: string): Promise<PricingResult<RebateDetail>> {
  return run('pricing:read', async ({ companyId }) => {
    const { rebateConfig } = getContainer();
    const [view, periods, settlements, timeline] = await Promise.all([
      rebateConfig.getView(companyId, id),
      rebateConfig.periods(companyId, id),
      rebateConfig.listSettlements(companyId, id, 50),
      rebateConfig.timeline(id),
    ]);
    const names: Record<string, string> = {};
    const ids = view.target.productIds ?? [];
    if (ids.length) {
      const { inArray } = await import('drizzle-orm');
      const { products } = await import('@/server/db/drizzle/schema');
      const rows = await drizzleDb
        .select({ id: products.id, name: products.name, sku: products.sku })
        .from(products)
        .where(inArray(products.id, ids));
      for (const r of rows) names[r.id] = `${r.name} (${r.sku})`;
    }
    return {
      program: {
        id: view.id,
        code: view.code,
        name: view.name,
        description: view.description,
        status: view.status,
        version: view.version,
        period: view.period,
        tierMode: view.tierMode,
        tiers: view.tiers,
        scopes: view.scopes,
        target: view.target,
        validFrom: view.validFrom.toISOString(),
        validTo: view.validTo?.toISOString() ?? null,
        summary: view.summary,
        current: view.current,
      },
      periods,
      settlements: settlements.map((s) => ({
        id: s.id,
        customerName: s.customerName,
        periodKey: s.periodKey,
        amount: Number(s.amount),
        status: s.status,
        creditRef: s.creditRef,
        createdAt: s.createdAt.toISOString(),
      })),
      timeline: timeline.map((t) => ({
        action: t.action,
        actor: t.actorId,
        at: t.occurredAt.toISOString(),
        reason: t.reasonText ?? t.reasonCode ?? null,
      })),
      names,
    };
  });
}

export async function checkRebateAction(
  form: RebateFormInput,
): Promise<PricingResult<{ errors: RuleIssue[]; warnings: RuleIssue[] }>> {
  return run('pricing:read', async () => checkRebateProgram(toInput(form)));
}

export async function saveRebateAction(
  form: RebateFormInput,
  reason: Reason,
  id?: string,
): Promise<PricingResult<{ id: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const { rebateConfig } = getContainer();
    const input = toInput(form);
    const row = id
      ? await rebateConfig.update(companyId, id, input, actor, reason)
      : await rebateConfig.create(companyId, input, actor, reason);
    revalidate();
    return { id: row.id };
  });
}

export async function rebateStatusAction(
  id: string,
  to: 'active' | 'paused' | 'retired',
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const { rebateConfig } = getContainer();
    if (to === 'active') await rebateConfig.activate(companyId, id, actor, reason);
    else if (to === 'paused') await rebateConfig.pause(companyId, id, actor, reason);
    else await rebateConfig.retire(companyId, id, actor, reason);
    revalidate();
    return null;
  });
}

export async function rebateStatementAction(
  id: string,
  period: string,
): Promise<PricingResult<Statement>> {
  return run('pricing:read', ({ companyId }) =>
    getContainer().rebateConfig.statement(companyId, id, period),
  );
}

export async function requestRebateSettlementAction(
  input: { programId: string; customerId: string; periodKey: string },
  reason: Reason,
): Promise<PricingResult<{ pending: boolean; message?: string }>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const r = await getContainer().rebateConfig.requestSettlement(companyId, input, actor, reason);
    revalidate();
    return r.outcome === 'settled' ? { pending: false } : { pending: true, message: r.message };
  });
}

// ── Loyalty ──────────────────────────────────────────────────────────────────

export async function getLoyaltyAction(): Promise<PricingResult<LoyaltyProgramView | null>> {
  return run('pricing:read', ({ companyId }) => getContainer().loyalty.program(companyId));
}

export async function checkLoyaltyAction(
  config: LoyaltyConfig,
): Promise<PricingResult<{ errors: RuleIssue[]; warnings: RuleIssue[] }>> {
  return run('pricing:read', async () => checkLoyaltyFor(config));
}

export async function saveLoyaltyAction(
  input: { name: string; status: 'active' | 'paused'; config: LoyaltyConfig },
  reason: Reason,
): Promise<PricingResult<LoyaltyProgramView>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const v = await getContainer().loyalty.saveProgram(companyId, input, actor, reason);
    revalidate();
    return v;
  });
}

export async function loyaltyAccountAction(
  customerId: string,
): Promise<PricingResult<LoyaltyAccountView>> {
  return run('pricing:read', ({ companyId }) =>
    getContainer().loyalty.account(companyId, customerId),
  );
}

export async function adjustLoyaltyAction(
  customerId: string,
  points: number,
  note: string | null,
  reason: Reason,
): Promise<PricingResult<LoyaltyAccountView>> {
  return run('pricing:manage', ({ companyId, actor }) =>
    getContainer().loyalty.adjust(companyId, customerId, points, note, actor, reason),
  );
}

// ── Gift cards ───────────────────────────────────────────────────────────────

export async function listGiftCardsAction(search?: string): Promise<PricingResult<GiftCardView[]>> {
  return run('pricing:read', ({ companyId }) => getContainer().giftCards.list(companyId, search));
}

export async function lookupGiftCardAction(code: string): Promise<PricingResult<GiftCardDetail>> {
  return run('pricing:read', ({ companyId }) => getContainer().giftCards.lookup(companyId, code));
}

export async function issueGiftCardsAction(
  input: {
    value: number;
    count: number;
    expiresAt: string | null;
    customerId: string | null;
    note: string | null;
  },
  reason: Reason,
): Promise<PricingResult<GiftCardView[]>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const cards = await getContainer().giftCards.issue(
      companyId,
      { ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null },
      actor,
      reason,
    );
    revalidate();
    return cards;
  });
}

export async function blockGiftCardAction(
  id: string,
  blocked: boolean,
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await getContainer().giftCards.setBlocked(companyId, id, blocked, actor, reason);
    revalidate();
    return null;
  });
}

// ── Paying an order with a card or points ────────────────────────────────────

export interface OrderTenderInfo {
  total: number;
  tendered: number;
  due: number;
  canPay: boolean;
  /** Why not, when it cannot take a payment now. */
  cannotBecause: string | null;
  loyalty: { active: boolean; balance: number; pointValue: number; maxPercent: number } | null;
  applied: Array<{ kind: string; amount: number; points: number | null; at: string }>;
}

export async function orderTenderInfoAction(
  orderId: string,
): Promise<PricingResult<OrderTenderInfo>> {
  return run('orders:read', async ({ companyId }) => {
    const [o] = await drizzleDb.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new PricingConfigError('NOT_FOUND', 'That order does not exist.');
    const applied = await drizzleDb
      .select()
      .from(orderTenders)
      .where(eq(orderTenders.orderId, orderId));
    const total = Number(o.totalAmount);
    const tendered = Number(o.tenderedAmount);
    const due = amountDue({ totalAmount: total, tenderedAmount: tendered });
    const cannotBecause = ['cancelled', 'failed', 'refunded'].includes(o.status)
      ? `A ${o.status} order cannot take a payment.`
      : ['paid', 'reconciled'].includes(o.paymentStatus)
        ? 'This order is already paid.'
        : o.paymentStatus === 'pending_verification'
          ? 'A payment is being confirmed.'
          : ['pending', 'rejected', 'draft'].includes(o.approvalStatus)
            ? 'This order is waiting for approval.'
            : o.paymentMethod === 'on_account'
              ? 'This order is on the customer account.'
              : due <= 0
                ? 'Nothing is left to pay.'
                : null;
    const { loyalty } = getContainer();
    const cfg = await loyalty.activeConfig(companyId);
    let loyaltyInfo: OrderTenderInfo['loyalty'] = null;
    if (cfg && o.tradeCustomerId) {
      const acct = await loyalty.account(companyId, o.tradeCustomerId, 1);
      loyaltyInfo = {
        active: true,
        balance: acct.balance,
        pointValue: cfg.pointValue,
        maxPercent: cfg.maxRedeemPercent,
      };
    }
    return {
      total,
      tendered,
      due,
      canPay: cannotBecause == null,
      cannotBecause,
      loyalty: loyaltyInfo,
      applied: applied.map((a) => ({
        kind: a.kind,
        amount: Number(a.amount),
        points: a.points,
        at: a.createdAt.toISOString(),
      })),
    };
  });
}

export async function applyTenderAction(
  orderId: string,
  input: TenderInput,
): Promise<PricingResult<TenderResult>> {
  return run('orders:update', async ({ companyId, actor }) => {
    const r = await getContainer().tenders.apply(companyId, orderId, input, actor);
    revalidatePath('/admin/orders');
    return r;
  });
}
