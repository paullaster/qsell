import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  branches,
  customerReceipts,
  financeSettings,
  glAccounts,
  paymentMethods,
  paymentProviderConfigs,
  type PaymentMethodKind,
  type PaymentMethodRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { findTemplate } from '../domain/templates';
import { toCents } from '../domain/receivables';
import { ensureManualProvider } from '@/server/domains/payments/manual-provider';
import { FinanceError, type FinanceContext } from '../errors';

export const METHOD_KINDS: PaymentMethodKind[] = [
  'cash', 'bank_transfer', 'bank_deposit', 'cheque', 'mobile_money', 'card', 'gateway', 'wallet', 'gift_card', 'offset', 'other',
];
export const USABLE_FOR = ['customer_receipt', 'customer_refund', 'vendor_payment', 'vendor_receipt'] as const;

export interface PaymentMethodInput {
  code: string;
  name: string;
  kind: PaymentMethodKind;
  /** The real bank, cash or mobile-money account the money lands in (statements come from it). */
  balancingBankAccountId: string;
  /** The one provider this method goes through. Required; the built-in Manual one for cash and cheques. */
  providerId: string;
  /** The branch it belongs to. Empty = every branch. */
  branchId?: string | null;
  /** The G/L account its money posts to. */
  glAccountId: string;
  /** What the number is (paybill, till, account) and the number itself. */
  channelKind?: string | null;
  channelNumber?: string | null;
  requiresReference?: boolean;
  requiresEvidence?: boolean;
  requiresCounterparty?: boolean;
  usableFor?: string[];
  settlementMode?: 'immediate' | 'delayed' | 'on_statement';
  settlementDays?: number;
  limits?: { min?: string; max?: string };
  refundDestination?: 'none' | 'manual' | 'automatic';
  legacyCodes?: string[];
  enabled?: boolean;
  sortOrder?: number;
}

/** How customers pay, and what that does to the books. Created and changed from a screen, never in code. */
export class PaymentMethodService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async list(companyId: string) {
    return this.db
      .select({
        method: paymentMethods,
        bankCode: bankAccounts.code,
        bankName: bankAccounts.name,
        bankCurrency: bankAccounts.currency,
        bankBlocked: bankAccounts.blocked,
        providerName: paymentProviderConfigs.displayName,
        providerCode: paymentProviderConfigs.providerCode,
        providerEnabled: paymentProviderConfigs.isEnabled,
        branchName: branches.name,
        glNo: glAccounts.no,
        glName: glAccounts.name,
      })
      .from(paymentMethods)
      .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, paymentMethods.providerId))
      .innerJoin(glAccounts, eq(glAccounts.id, paymentMethods.glAccountId))
      .leftJoin(branches, eq(branches.id, paymentMethods.branchId))
      .where(eq(paymentMethods.companyId, companyId))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.code));
  }

  async get(companyId: string, id: string): Promise<PaymentMethodRow | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.id, id)))
      .limit(1);
    return row ?? null;
  }

  private async check(db: Pick<DrizzleDb, 'select'>, companyId: string, input: PaymentMethodInput) {
    if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(input.code.trim())) {
      throw new FinanceError('CODE_INVALID', 'The code uses capital letters, digits, "-" or "_" (up to 30).');
    }
    if (!input.name.trim()) throw new FinanceError('INVALID', 'A payment method needs a name.');
    if (!METHOD_KINDS.includes(input.kind)) throw new FinanceError('INVALID', 'Unknown kind of payment method.');
    for (const u of input.usableFor ?? []) {
      if (!(USABLE_FOR as readonly string[]).includes(u)) throw new FinanceError('INVALID', `"${u}" is not something a method can be used for.`);
    }
    for (const k of ['min', 'max'] as const) {
      const v = input.limits?.[k];
      if (v !== undefined && v !== '') {
        try { toCents(v); } catch { throw new FinanceError('LIMIT_INVALID', `The ${k} limit "${v}" is not an amount.`); }
      }
    }
    if (input.limits?.min && input.limits?.max && toCents(input.limits.min) > toCents(input.limits.max)) {
      throw new FinanceError('LIMIT_INVALID', 'The minimum is higher than the maximum.');
    }
    const [bank] = await db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, input.balancingBankAccountId)))
      .limit(1);
    if (!bank) throw new FinanceError('BANK_NOT_FOUND', 'Choose the bank or cash account this method pays into.');
    if (bank.blocked) throw new FinanceError('BANK_BLOCKED', `${bank.code} is blocked.`);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.providerId ?? '')) throw new FinanceError('PROVIDER_REQUIRED', 'Choose the payment provider this method goes through (cash and cheques use the built-in Manual one).');
    if (!uuid.test(input.glAccountId ?? '')) throw new FinanceError('GL_REQUIRED', 'Choose the G/L account this method posts to.');
    const [provider] = await db
      .select({ id: paymentProviderConfigs.id })
      .from(paymentProviderConfigs)
      .where(and(eq(paymentProviderConfigs.companyId, companyId), eq(paymentProviderConfigs.id, input.providerId)))
      .limit(1);
    if (!provider) throw new FinanceError('PROVIDER_REQUIRED', 'Choose the payment provider this method goes through (cash and cheques use the built-in Manual one).');
    if (input.branchId) {
      const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.companyId, companyId), eq(branches.id, input.branchId))).limit(1);
      if (!b) throw new FinanceError('BRANCH_NOT_FOUND', 'That branch does not exist.');
    }
    const [gl] = await db.select().from(glAccounts).where(and(eq(glAccounts.companyId, companyId), eq(glAccounts.id, input.glAccountId))).limit(1);
    if (!gl) throw new FinanceError('GL_REQUIRED', 'Choose the G/L account this method posts to.');
    if (gl.type !== 'posting') throw new FinanceError('ACCOUNT_NOT_POSTING', `${gl.no} ${gl.name} is a heading; pick an account that can be posted to.`);
    if (gl.blocked) throw new FinanceError('ACCOUNT_BLOCKED', `${gl.no} ${gl.name} is blocked.`);
    if (gl.category !== 'assets') throw new FinanceError('ACCOUNT_NOT_ASSET', `${gl.no} ${gl.name} is not an asset account; money received is an asset.`);
    if (gl.currencyPolicy !== 'any' && gl.currencyPolicy !== bank.currency) throw new FinanceError('CURRENCY_MISMATCH', `${gl.no} only carries ${gl.currencyPolicy}, and ${bank.code} holds ${bank.currency}.`);
    if (input.channelNumber && input.channelNumber.length > 40) throw new FinanceError('INVALID', 'The paybill, till or account number is too long.');
    return bank;
  }

  async create(ctx: FinanceContext, input: PaymentMethodInput): Promise<PaymentMethodRow> {
    return this.db.transaction(async (tx) => {
      await this.check(tx, ctx.companyId, input);
      const [dup] = await tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.code, input.code.trim())));
      if (dup) throw new FinanceError('DUPLICATE', `A payment method with code ${input.code} already exists.`);
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          companyId: ctx.companyId,
          code: input.code.trim(),
          name: input.name.trim(),
          kind: input.kind,
          balancingBankAccountId: input.balancingBankAccountId,
          requiresReference: input.requiresReference ?? false,
          requiresEvidence: input.requiresEvidence ?? false,
          requiresCounterparty: input.requiresCounterparty ?? false,
          providerId: input.providerId,
          branchId: input.branchId ?? null,
          glAccountId: input.glAccountId,
          channelKind: input.channelKind?.trim() || null,
          channelNumber: input.channelNumber?.trim() || null,
          usableFor: input.usableFor ?? ['customer_receipt'],
          settlementMode: input.settlementMode ?? 'immediate',
          settlementDays: input.settlementDays ?? 0,
          limits: input.limits ?? {},
          refundDestination: input.refundDestination ?? 'none',
          legacyCodes: input.legacyCodes ?? [],
          enabled: input.enabled ?? true,
          sortOrder: input.sortOrder ?? 100,
          createdBy: ctx.actor.id ?? 'system',
        })
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'payment_method', id: row!.id },
          action: 'finance.payment_method_created',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { code: row!.code, kind: row!.kind, bankAccountId: row!.balancingBankAccountId, providerId: row!.providerId, branchId: row!.branchId, glAccountId: row!.glAccountId },
        },
        tx,
      );
      return row!;
    });
  }

  async update(ctx: FinanceContext, id: string, patch: Partial<PaymentMethodInput>): Promise<PaymentMethodRow> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, id)))
        .for('update');
      if (!current) throw new FinanceError('NOT_FOUND', 'That payment method does not exist.');
      if (patch.code && patch.code !== current.code) {
        throw new FinanceError('CODE_FIXED', 'The code of a payment method does not change; switch it off and add a new one.');
      }
      const merged: PaymentMethodInput = {
        code: current.code,
        name: patch.name ?? current.name,
        kind: patch.kind ?? current.kind,
        balancingBankAccountId: patch.balancingBankAccountId ?? current.balancingBankAccountId,
        requiresReference: patch.requiresReference ?? current.requiresReference,
        requiresEvidence: patch.requiresEvidence ?? current.requiresEvidence,
        requiresCounterparty: patch.requiresCounterparty ?? current.requiresCounterparty,
        providerId: patch.providerId ?? current.providerId,
        branchId: patch.branchId === undefined ? current.branchId : patch.branchId,
        glAccountId: patch.glAccountId ?? current.glAccountId,
        channelKind: patch.channelKind === undefined ? current.channelKind : patch.channelKind,
        channelNumber: patch.channelNumber === undefined ? current.channelNumber : patch.channelNumber,
        usableFor: patch.usableFor ?? current.usableFor,
        settlementMode: patch.settlementMode ?? current.settlementMode,
        settlementDays: patch.settlementDays ?? current.settlementDays,
        limits: patch.limits ?? current.limits,
        refundDestination: patch.refundDestination ?? current.refundDestination,
        legacyCodes: patch.legacyCodes ?? current.legacyCodes,
        enabled: patch.enabled ?? current.enabled,
        sortOrder: patch.sortOrder ?? current.sortOrder,
      };
      await this.check(tx, ctx.companyId, merged);
      if (patch.glAccountId && patch.glAccountId !== current.glAccountId) {
        const [moved] = await tx.select({ id: bankLedgerEntries.id }).from(bankLedgerEntries).where(eq(bankLedgerEntries.glAccountId, current.glAccountId)).limit(1);
        const [used] = await tx.select({ id: customerReceipts.id }).from(customerReceipts).where(eq(customerReceipts.paymentMethodId, id)).limit(1);
        if (used && moved) throw new FinanceError('METHOD_IN_USE', 'Receipts were posted through this method, so its G/L account cannot change. Switch it off and add a new method.');
      }
      const [row] = await tx
        .update(paymentMethods)
        .set({
          name: merged.name.trim(),
          kind: merged.kind,
          balancingBankAccountId: merged.balancingBankAccountId,
          requiresReference: merged.requiresReference,
          requiresEvidence: merged.requiresEvidence,
          requiresCounterparty: merged.requiresCounterparty,
          providerId: merged.providerId,
          branchId: merged.branchId ?? null,
          glAccountId: merged.glAccountId,
          channelKind: merged.channelKind?.trim() || null,
          channelNumber: merged.channelNumber?.trim() || null,
          usableFor: merged.usableFor,
          settlementMode: merged.settlementMode,
          settlementDays: merged.settlementDays,
          limits: merged.limits,
          refundDestination: merged.refundDestination,
          legacyCodes: merged.legacyCodes,
          enabled: merged.enabled,
          sortOrder: merged.sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(paymentMethods.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'payment_method', id },
          action: 'finance.payment_method_updated',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, changed: Object.keys(patch) },
        },
        tx,
      );
      return row!;
    });
  }

  async setEnabled(ctx: FinanceContext, id: string, enabled: boolean, reason?: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentMethods)
        .set({ enabled, updatedAt: new Date() })
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, id)))
        .returning({ id: paymentMethods.id });
      if (!row) throw new FinanceError('NOT_FOUND', 'That payment method does not exist.');
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'payment_method', id },
          action: enabled ? 'finance.payment_method_enabled' : 'finance.payment_method_disabled',
          actor: ctx.actor,
          reason: reason ? { text: reason } : undefined,
          inputs: { origin: ctx.origin },
        },
        tx,
      );
    });
  }

  async delete(ctx: FinanceContext, id: string) {
    await this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, id))).for('update');
      if (!m) throw new FinanceError('NOT_FOUND', 'That payment method does not exist.');
      const [used] = await tx.select({ id: customerReceipts.id }).from(customerReceipts).where(eq(customerReceipts.paymentMethodId, id)).limit(1);
      if (used) throw new FinanceError('METHOD_IN_USE', 'Receipts were recorded with this method; switch it off instead of deleting it.');
      await tx.delete(paymentMethods).where(eq(paymentMethods.id, id));
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'payment_method', id },
          action: 'finance.payment_method_deleted',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, code: m.code },
        },
        tx,
      );
    });
  }

  /**
   * Creates the standard bank accounts and payment methods of the chart template that was applied
   * (anything that already exists is left alone). Providers are linked to the default branch's
   * account for that provider when there is one.
   */
  async seedStandard(ctx: FinanceContext): Promise<{ bankAccounts: number; methods: number }> {
    return this.db.transaction(async (tx) => {
      const [settings] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId)).limit(1);
      if (!settings?.chartTemplate) {
        throw new FinanceError('FINANCE_NOT_SET_UP', 'Apply a chart of accounts first (Finance → Chart of accounts).');
      }
      const template = findTemplate(settings.chartTemplate);
      if (!template) throw new FinanceError('TEMPLATE_UNKNOWN', `The template "${settings.chartTemplate}" is no longer available.`);

      const gl = new Map(
        (await tx.select({ id: glAccounts.id, no: glAccounts.no }).from(glAccounts).where(eq(glAccounts.companyId, ctx.companyId))).map((a) => [a.no, a.id]),
      );
      const existingBanks = new Map(
        (await tx.select({ id: bankAccounts.id, code: bankAccounts.code }).from(bankAccounts).where(eq(bankAccounts.companyId, ctx.companyId))).map((b) => [b.code, b.id]),
      );
      let banksCreated = 0;
      for (const b of template.bankAccounts) {
        if (existingBanks.has(b.code)) continue;
        if (!gl.get(b.glAccount)) continue; // the company removed that account from its chart: skip rather than guess
        const [row] = await tx
          .insert(bankAccounts)
          .values({
            companyId: ctx.companyId,
            code: b.code,
            name: b.name,
            kind: b.kind,
            currency: settings.baseCurrency,
            feeGlAccountId: b.feeAccount ? (gl.get(b.feeAccount) ?? null) : null,
            createdBy: ctx.actor.id ?? 'system',
          })
          .returning({ id: bankAccounts.id });
        existingBanks.set(b.code, row!.id);
        banksCreated += 1;
      }

      const manual = await ensureManualProvider(tx, ctx.companyId);
      const providers = await tx
        .select({ id: paymentProviderConfigs.id, code: paymentProviderConfigs.providerCode })
        .from(paymentProviderConfigs)
        .where(eq(paymentProviderConfigs.companyId, ctx.companyId))
        .orderBy(asc(paymentProviderConfigs.createdAt));
      // A method that stands for an outside service goes through the first provider of that service, if there is one.
      const providerByCode = new Map<string, string>();
      for (const p of providers) if (!providerByCode.has(p.code as string)) providerByCode.set(p.code as string, p.id);
      const glByBank = new Map(template.bankAccounts.map((b) => [b.code, gl.get(b.glAccount)]));

      const existingMethods = new Set(
        (await tx.select({ code: paymentMethods.code }).from(paymentMethods).where(eq(paymentMethods.companyId, ctx.companyId))).map((m) => m.code),
      );
      let methodsCreated = 0;
      for (const m of template.paymentMethods) {
        if (existingMethods.has(m.code)) continue;
        const bankId = existingBanks.get(m.bankAccount);
        const glId = glByBank.get(m.bankAccount);
        if (!bankId || !glId) continue;
        await tx.insert(paymentMethods).values({
          companyId: ctx.companyId,
          code: m.code,
          name: m.name,
          kind: m.kind,
          balancingBankAccountId: bankId,
          requiresReference: m.requiresReference ?? false,
          requiresEvidence: m.requiresEvidence ?? false,
          requiresCounterparty: m.requiresCounterparty ?? false,
          providerId: (m.provider ? providerByCode.get(m.provider) : undefined) ?? manual.id,
          glAccountId: glId,
          usableFor: (m.refundDestination ?? 'none') === 'none' ? ['customer_receipt'] : ['customer_receipt', 'customer_refund'],
          refundDestination: m.refundDestination ?? 'none',
          legacyCodes: m.legacyCodes ?? [],
          sortOrder: m.sortOrder,
          createdBy: ctx.actor.id ?? 'system',
        });
        methodsCreated += 1;
      }
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'payment_setup', id: ctx.companyId },
          action: 'finance.payment_setup_seeded',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, template: template.code },
          outcome: { bankAccounts: banksCreated, methods: methodsCreated },
        },
        tx,
      );
      return { bankAccounts: banksCreated, methods: methodsCreated };
    });
  }

  /**
   * Fills `orders.payment_method_id` for orders that only carry the old provider text, in small
   * batches so a large table is never locked for long. Safe to run repeatedly.
   */
  async backfillOrders(ctx: FinanceContext): Promise<number> {
    const methods = await this.db
      .select({ id: paymentMethods.id, legacy: paymentMethods.legacyCodes })
      .from(paymentMethods)
      .where(eq(paymentMethods.companyId, ctx.companyId));
    let total = 0;
    for (const m of methods) {
      if (m.legacy.length === 0) continue;
      for (;;) {
        const res = await this.db.execute<{ id: string }>(sql`
          WITH batch AS (
            SELECT id FROM orders WHERE payment_method_id IS NULL AND payment_method IN (${sql.join(m.legacy.map((c) => sql`${c}`), sql`, `)})
            LIMIT 5000 FOR UPDATE SKIP LOCKED
          )
          UPDATE orders o SET payment_method_id = ${m.id}::uuid FROM batch WHERE o.id = batch.id
          RETURNING o.id`);
        const n = [...res].length;
        total += n;
        if (n < 5000) break;
      }
    }
    if (total > 0) {
      await this.decisions.record({
        companyId: ctx.companyId,
        subject: { type: 'payment_setup', id: ctx.companyId },
        action: 'finance.orders_linked_to_methods',
        actor: ctx.actor,
        inputs: { origin: ctx.origin },
        outcome: { orders: total },
      });
    }
    return total;
  }

  /** The providers a method can go through (the built-in Manual one is always there). */
  async providerChoices(companyId: string) {
    await ensureManualProvider(this.db, companyId);
    return this.db
      .select({
        id: paymentProviderConfigs.id,
        providerCode: paymentProviderConfigs.providerCode,
        displayName: paymentProviderConfigs.displayName,
        isEnabled: paymentProviderConfigs.isEnabled,
        isSystem: paymentProviderConfigs.isSystem,
        environment: paymentProviderConfigs.environment,
      })
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.companyId, companyId))
      .orderBy(asc(paymentProviderConfigs.isSystem), asc(paymentProviderConfigs.displayName));
  }

  async methodsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db.select().from(paymentMethods).where(inArray(paymentMethods.id, ids));
  }
}
