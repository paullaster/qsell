import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerCreditPolicies, customerPostingGroups, customers, financeSettings } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { fromCents, toCents } from '../domain/receivables';
import { pickPolicy, type CreditPolicy, type PolicyRow } from '../domain/wallet';
import { FinanceError, type FinanceContext } from '../errors';

import { has } from '@/lib/values';

type Reader = Pick<DrizzleDb, 'select'>;

export interface PolicyInput {
  groupCode: string | null;
  walletEnabled: boolean;
  allowDeposits: boolean;
  overpaymentDefault: 'wallet' | 'hold' | 'ask';
  autoApply: 'never' | 'oldest_first';
  creditNoteExcess: 'wallet' | 'ask';
  refundsEnabled: boolean;
  walletCashOut: boolean;
  maxBalance: string | null;
  label: string;
}

/** The "refund or wallet" switch: effective-dated rules, per company and per customer group. */
export class CreditPolicyService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  private toRow(r: typeof customerCreditPolicies.$inferSelect): PolicyRow {
    return {
      groupCode: r.groupCode,
      effectiveFrom: r.effectiveFrom,
      walletEnabled: r.walletEnabled,
      allowDeposits: r.allowDeposits,
      overpaymentDefault: r.overpaymentDefault,
      autoApply: r.autoApply,
      creditNoteExcess: r.creditNoteExcessDefault,
      refundsEnabled: r.refundsEnabled,
      walletCashOut: r.walletCashOut,
      maxCents: r.maxBalance === null ? null : toCents(r.maxBalance),
      label: r.label,
    };
  }

  /** The policy in force for a customer today (or on a given date). */
  async forCustomer(r: Reader, companyId: string, customerId: string, date = businessDate()): Promise<CreditPolicy & { source: string; groupCode: string }> {
    const [[c], [s], rows] = await Promise.all([
      r.select({ g: customers.postingGroupCode }).from(customers).where(eq(customers.id, customerId)),
      r.select({ d: financeSettings.defaultCustomerGroup }).from(financeSettings).where(eq(financeSettings.companyId, companyId)),
      r.select().from(customerCreditPolicies).where(eq(customerCreditPolicies.companyId, companyId)),
    ]);
    const group = c?.g ?? s?.d ?? 'DOMESTIC';
    return { ...pickPolicy(rows.map((x) => this.toRow(x)), group, date), groupCode: group };
  }

  /** What the company-wide policy is, for the name shown on screens. */
  async companyPolicy(r: Reader, companyId: string, date = businessDate()): Promise<CreditPolicy & { source: string }> {
    const rows = await r.select().from(customerCreditPolicies).where(eq(customerCreditPolicies.companyId, companyId));
    return pickPolicy(rows.map((x) => this.toRow(x)), null, date);
  }

  async list(companyId: string) {
    const [rows, groups] = await Promise.all([
      this.db.select().from(customerCreditPolicies).where(eq(customerCreditPolicies.companyId, companyId)).orderBy(asc(customerCreditPolicies.groupCode), asc(customerCreditPolicies.effectiveFrom)),
      this.db.select({ code: customerPostingGroups.code, name: customerPostingGroups.name }).from(customerPostingGroups).where(eq(customerPostingGroups.companyId, companyId)),
    ]);
    return { rows, groups };
  }

  /** Saves a policy from today. A change made the same day replaces that day's row. */
  async save(ctx: FinanceContext, input: PolicyInput) {
    const label = input.label.trim();
    if (!has(label) || label.length > 40) throw new FinanceError('LABEL_INVALID', 'Give it a short name, such as Wallet or Store credit.');
    let max: string | null = null;
    if (input.maxBalance !== null && input.maxBalance.trim() !== '') {
      try {
        if (toCents(input.maxBalance) <= 0) throw new Error();
        max = fromCents(toCents(input.maxBalance));
      } catch {
        throw new FinanceError('LIMIT_INVALID', 'The most a wallet may hold must be an amount above zero.');
      }
    }
    const today = businessDate();
    await this.db.transaction(async (tx) => {
      if (has(input.groupCode)) {
        const [g] = await tx.select({ id: customerPostingGroups.id }).from(customerPostingGroups).where(and(eq(customerPostingGroups.companyId, ctx.companyId), eq(customerPostingGroups.code, input.groupCode)));
        if (!g) throw new FinanceError('GROUP_NOT_FOUND', `Customer posting group ${input.groupCode} does not exist.`);
      }
      const values = {
        walletEnabled: input.walletEnabled,
        allowDeposits: input.allowDeposits,
        overpaymentDefault: input.overpaymentDefault,
        autoApply: input.autoApply,
        creditNoteExcessDefault: input.creditNoteExcess,
        refundsEnabled: input.refundsEnabled,
        walletCashOut: input.walletCashOut,
        maxBalance: max,
        label,
        createdBy: ctx.actor.id ?? 'system',
      };
      const [same] = await tx
        .select({ id: customerCreditPolicies.id })
        .from(customerCreditPolicies)
        .where(
          and(
            eq(customerCreditPolicies.companyId, ctx.companyId),
            input.groupCode === null ? sql`${customerCreditPolicies.groupCode} IS NULL` : eq(customerCreditPolicies.groupCode, input.groupCode),
            eq(customerCreditPolicies.effectiveFrom, today),
          ),
        )
        .for('update');
      if (same) await tx.update(customerCreditPolicies).set(values).where(eq(customerCreditPolicies.id, same.id));
      else await tx.insert(customerCreditPolicies).values({ companyId: ctx.companyId, groupCode: input.groupCode, effectiveFrom: today, ...values });
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'customer_credit_policy', id: input.groupCode ?? 'company' },
          action: 'finance.credit_policy_saved',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { effectiveFrom: today, walletEnabled: input.walletEnabled, allowDeposits: input.allowDeposits, overpaymentDefault: input.overpaymentDefault, autoApply: input.autoApply, creditNoteExcess: input.creditNoteExcess, refundsEnabled: input.refundsEnabled, walletCashOut: input.walletCashOut, maxBalance: max, label },
        },
        tx,
      );
    });
  }
}
