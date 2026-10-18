import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  businessPostingGroups,
  customerPostingGroups,
  generalPostingSetup,
  productPostingGroups,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import {
  resolveCustomer,
  resolveGeneral,
  type CustomerGroupRow,
  type CustomerPurpose,
  type GeneralPurpose,
  type GeneralSetupRow,
} from './domain/setup';
import { addDays } from './domain/periods';
import { FinanceError, type FinanceContext } from './errors';

export interface GeneralSetupInput {
  businessGroupId: string;
  productGroupId: string;
  effectiveFrom: string;
  accounts: Partial<Record<GeneralPurpose, string | null>>;
}

const GENERAL_COLUMNS: Record<GeneralPurpose, keyof typeof generalPostingSetup.$inferInsert> = {
  sales: 'salesAccountId',
  sales_returns: 'salesReturnsAccountId',
  sales_discount: 'salesDiscountAccountId',
  cogs: 'cogsAccountId',
  inventory_adjustment: 'inventoryAdjustmentAccountId',
  inventory: 'inventoryAccountId',
  inventory_clearing: 'inventoryClearingAccountId',
};

export class PostingSetupService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async overview(companyId: string) {
    const [business, product, general, customer] = await Promise.all([
      this.db.select().from(businessPostingGroups).where(eq(businessPostingGroups.companyId, companyId)),
      this.db.select().from(productPostingGroups).where(eq(productPostingGroups.companyId, companyId)),
      this.db.select().from(generalPostingSetup).where(eq(generalPostingSetup.companyId, companyId)),
      this.db.select().from(customerPostingGroups).where(eq(customerPostingGroups.companyId, companyId)),
    ]);
    return { business, product, general, customer };
  }

  async addGroup(ctx: FinanceContext, kind: 'business' | 'product', code: string, name: string) {
    const table = kind === 'business' ? businessPostingGroups : productPostingGroups;
    if (code.trim() === '' || name.trim() === '') throw new FinanceError('GROUP_INVALID', 'A group needs a code and a name.');
    await this.db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, ctx.companyId), eq(table.code, code.trim())));
      if (dup) throw new FinanceError('DUPLICATE_GROUP', `Group ${code} already exists.`);
      const [row] = await tx.insert(table).values({ companyId: ctx.companyId, code: code.trim(), name: name.trim() }).returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: `${kind}_posting_group`, id: row.id },
          action: 'finance.posting_group_created',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { code: row.code, name: row.name },
        },
        tx,
      );
    });
  }

  /** Adds a new row of general posting setup that takes effect on `effectiveFrom`. */
  async saveGeneral(ctx: FinanceContext, input: GeneralSetupInput) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
      throw new FinanceError('DATE_INVALID', 'The effective date is not a date.');
    }
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(generalPostingSetup)
        .where(
          and(
            eq(generalPostingSetup.companyId, ctx.companyId),
            eq(generalPostingSetup.businessGroupId, input.businessGroupId),
            eq(generalPostingSetup.productGroupId, input.productGroupId),
          ),
        );
      const sameDay = existing.find((r) => r.effectiveFrom === input.effectiveFrom);
      const values: Record<string, string | null> = {};
      for (const [purpose, column] of Object.entries(GENERAL_COLUMNS)) {
        values[column] = input.accounts[purpose as GeneralPurpose] ?? null;
      }
      if (sameDay) {
        await tx.update(generalPostingSetup).set(values).where(eq(generalPostingSetup.id, sameDay.id));
      } else {
        // The row in force just before this one now ends the day before.
        const previous = existing
          .filter((r) => r.effectiveFrom < input.effectiveFrom)
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
        if (previous) {
          await tx
            .update(generalPostingSetup)
            .set({ effectiveTo: addDays(input.effectiveFrom, -1) })
            .where(eq(generalPostingSetup.id, previous.id));
        }
        const next = existing
          .filter((r) => r.effectiveFrom > input.effectiveFrom)
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
        await tx.insert(generalPostingSetup).values({
          companyId: ctx.companyId,
          businessGroupId: input.businessGroupId,
          productGroupId: input.productGroupId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: next ? addDays(next.effectiveFrom, -1) : null,
          ...values,
        });
      }
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'general_posting_setup', id: `${input.businessGroupId}:${input.productGroupId}` },
          action: 'finance.general_setup_saved',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, effectiveFrom: input.effectiveFrom },
          outcome: { accounts: input.accounts },
        },
        tx,
      );
    });
  }

  async loadGeneral(companyId: string): Promise<GeneralSetupRow[]> {
    const { business, product, general } = await this.overview(companyId);
    const biz = new Map(business.map((b) => [b.id, b.code]));
    const prod = new Map(product.map((p) => [p.id, p.code]));
    return general.map((r) => ({
      id: r.id,
      businessGroup: biz.get(r.businessGroupId) ?? '',
      productGroup: prod.get(r.productGroupId) ?? '',
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      accounts: {
        sales: r.salesAccountId,
        sales_returns: r.salesReturnsAccountId,
        sales_discount: r.salesDiscountAccountId,
        cogs: r.cogsAccountId,
        inventory_adjustment: r.inventoryAdjustmentAccountId,
        inventory: r.inventoryAccountId,
        inventory_clearing: r.inventoryClearingAccountId,
      },
    }));
  }

  async resolveGeneral(companyId: string, business: string, product: string, purpose: GeneralPurpose, date: string) {
    return resolveGeneral(await this.loadGeneral(companyId), business, product, purpose, date);
  }

  async resolveCustomer(companyId: string, group: string, purpose: CustomerPurpose) {
    const rows = await this.db.select().from(customerPostingGroups).where(eq(customerPostingGroups.companyId, companyId));
    const groups: CustomerGroupRow[] = rows.map((r) => ({
      id: r.id,
      code: r.code,
      accounts: {
        receivables: r.receivablesAccountId,
        customer_deposits: r.customerDepositsAccountId,
        refunds_payable: r.refundsPayableAccountId,
        payment_discount: r.paymentDiscountAccountId,
        write_off: r.writeOffAccountId,
        rounding: r.roundingAccountId,
        fx_gain: r.fxGainAccountId,
        fx_loss: r.fxLossAccountId,
        service_charge: r.serviceChargeAccountId,
        rebate_expense: r.rebateExpenseAccountId,
        gift_card_liability: r.giftCardLiabilityAccountId,
        loyalty_provision: r.loyaltyProvisionAccountId,
        credit_forfeit: r.creditForfeitAccountId,
        credit_adjustment: r.creditAdjustmentAccountId,
      },
    }));
    return resolveCustomer(groups, group, purpose);
  }
}
