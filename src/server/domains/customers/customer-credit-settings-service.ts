import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerCreditSettings } from '@/server/db/drizzle/schema';
import {
  DEFAULT_ALLOW_OVER_CREDIT_LIMIT,
  DEFAULT_CREDIT_LIMIT_DISPLAY,
  isCreditLimitDisplay,
  type CreditLimitDisplay,
} from '@/lib/customer-credit-settings';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import type { Tx } from '@/server/kernel/approvals/engine';

export class CustomerCreditSettingsError extends Error {}

export interface CustomerCreditSettingsView {
  creditLimitDisplay: CreditLimitDisplay;
  allowOverCreditLimit: boolean;
}

type Writer = DrizzleDb | Tx;

export class CustomerCreditSettingsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  async get(companyId: string): Promise<CustomerCreditSettingsView> {
    const [row] = await this.db
      .select()
      .from(customerCreditSettings)
      .where(eq(customerCreditSettings.companyId, companyId))
      .limit(1);
    return {
      creditLimitDisplay:
        row !== undefined && isCreditLimitDisplay(row.creditLimitDisplay)
          ? row.creditLimitDisplay
          : DEFAULT_CREDIT_LIMIT_DISPLAY,
      allowOverCreditLimit: row?.allowOverCreditLimit ?? DEFAULT_ALLOW_OVER_CREDIT_LIMIT,
    };
  }

  async saveDisplay(
    companyId: string,
    raw: unknown,
    actor: Actor,
    reason: ReasonInput,
    writer: Writer = this.db,
  ): Promise<CustomerCreditSettingsView> {
    if (!isCreditLimitDisplay(raw))
      throw new CustomerCreditSettingsError('Choose running or static display.');
    const why = await this.reasons.require(companyId, reason, 'selling_configuration');
    const before = await this.get(companyId);
    await writer
      .insert(customerCreditSettings)
      .values({
        companyId,
        creditLimitDisplay: raw,
        allowOverCreditLimit: before.allowOverCreditLimit,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: customerCreditSettings.companyId,
        set: { creditLimitDisplay: raw, updatedAt: new Date() },
      });
    await this.decisions.record(
      {
        companyId,
        actor,
        subject: { type: 'customer_credit_settings', id: 'credit_limit_display' },
        action: 'customer_credit.display_changed',
        reason: why,
        inputs: { creditLimitDisplay: before.creditLimitDisplay },
        outcome: { creditLimitDisplay: raw },
      },
      writer,
    );
    return { ...before, creditLimitDisplay: raw };
  }

  async setAllowOverCreditLimit(
    companyId: string,
    enabled: unknown,
    reason: ReasonInput,
    actor: Actor,
    writer: Writer = this.db,
  ): Promise<CustomerCreditSettingsView> {
    const next = enabled === true;
    const why = await this.reasons.require(companyId, reason, 'selling_configuration');
    const before = await this.get(companyId);
    await writer
      .insert(customerCreditSettings)
      .values({
        companyId,
        creditLimitDisplay: before.creditLimitDisplay,
        allowOverCreditLimit: next,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: customerCreditSettings.companyId,
        set: { allowOverCreditLimit: next, updatedAt: new Date() },
      });
    await this.decisions.record(
      {
        companyId,
        actor,
        subject: { type: 'customer_credit_settings', id: 'allow_over_credit_limit' },
        action: next ? 'customer_credit.over_limit_enabled' : 'customer_credit.over_limit_disabled',
        reason: why,
        inputs: { allowOverCreditLimit: before.allowOverCreditLimit },
        outcome: { allowOverCreditLimit: next },
      },
      writer,
    );
    return { ...before, allowOverCreditLimit: next };
  }
}
