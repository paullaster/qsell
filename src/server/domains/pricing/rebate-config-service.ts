import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  categories,
  customerDetailedEntries,
  customerLedgerEntries,
  customers,
  decisionLog,
  productGroups,
  rebateAccruals,
  rebateBalances,
  rebatePrograms,
  rebateSettlements,
  type RebateProgramRow,
  type RebateSettlementRow,
} from '@/server/db/drizzle/schema';
import { withAfterCommit } from '@/server/kernel/after-commit';
import type { ApprovalEngine, Tx } from '@/server/kernel/approvals/engine';
import type { Actor } from '@/server/kernel/context';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import {
  checkRebateProgram,
  effectivePercent,
  periodEnded,
  periodKey,
  periodLabel,
  rebateFor,
  summariseRebate,
  toNextTier,
  type RebateProgramInput,
} from './domain/rebate';
import type { RuleIssue } from './domain/rules';
import type { RebateService } from './rebate-service';

type Why = ReasonInput;
const MAX_STATEMENT_ROWS = 2000;

export interface RebateProgramView extends RebateProgramRow {
  summary: string;
  /** The running period: how many customers are counted and what they have bought. */
  current: { key: string; label: string; customers: number; basis: number };
}

export interface StatementRow {
  customerId: string;
  customerName: string;
  customerNumber: string | null;
  basis: number;
  percent: number;
  amount: number;
  next: { needed: number; percent: number } | null;
  settlement: { id: string; status: RebateSettlementRow['status']; amount: number } | null;
}

export interface Statement {
  programId: string;
  periodKey: string;
  label: string;
  ended: boolean;
  rows: StatementRow[];
  totalBasis: number;
  totalAmount: number;
  truncated: boolean;
}

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

const toInput = (r: RebateProgramRow): RebateProgramInput => ({
  code: r.code,
  name: r.name,
  period: r.period,
  tierMode: r.tierMode,
  tiers: r.tiers,
  scopes: r.scopes,
  target: r.target,
  validFrom: r.validFrom,
  validTo: r.validTo,
});

/**
 * Everything an administrator does with rebate programmes, and paying a rebate out. A programme in
 * force cannot be edited (pause it first), every change needs a reason and is logged, and paying
 * a rebate is a settlement that goes through approval, because it is money leaving.
 */
export class RebateConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly rebates: RebateService,
    private readonly approvals: ApprovalEngine,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  private normaliseCode(raw: string) {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))
      throw new PricingConfigError(
        'INVALID',
        'The code can use letters, numbers, "-" and "_" (up to 40).',
      );
    return code;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async namesFor(rows: RebateProgramRow[]) {
    const catIds = [...new Set(rows.flatMap((r) => r.target.categoryIds ?? []))];
    const groupIds = [...new Set(rows.flatMap((r) => r.target.productGroupIds ?? []))];
    const [cats, groups] = await Promise.all([
      catIds.length
        ? this.db
            .select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(inArray(categories.id, catIds))
        : [],
      groupIds.length
        ? this.db
            .select({ id: productGroups.id, name: productGroups.name })
            .from(productGroups)
            .where(inArray(productGroups.id, groupIds))
        : [],
    ]);
    return {
      category: Object.fromEntries(cats.map((c) => [c.id, c.name])),
      group: Object.fromEntries(groups.map((g) => [g.id, g.name])),
    };
  }

  async list(companyId: string): Promise<RebateProgramView[]> {
    const rows = await this.db
      .select()
      .from(rebatePrograms)
      .where(eq(rebatePrograms.companyId, companyId))
      .orderBy(asc(rebatePrograms.status), desc(rebatePrograms.createdAt));
    if (rows.length === 0) return [];
    const names = await this.namesFor(rows);
    const now = new Date();
    const totals = await this.db
      .select({
        programId: rebateBalances.programId,
        periodKey: rebateBalances.periodKey,
        customers: sql<number>`count(*)::int`,
        basis: sql<string>`coalesce(sum(${rebateBalances.basis}), 0)`,
      })
      .from(rebateBalances)
      .where(
        inArray(
          rebateBalances.programId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(rebateBalances.programId, rebateBalances.periodKey);
    return rows.map((r) => {
      const key = periodKey(now, r.period);
      const t = totals.find((x) => x.programId === r.id && x.periodKey === key);
      return {
        ...r,
        summary: summariseRebate(toInput(r), names),
        current: {
          key,
          label: periodLabel(key),
          customers: t?.customers ?? 0,
          basis: num(t?.basis),
        },
      };
    });
  }

  async get(companyId: string, id: string): Promise<RebateProgramRow> {
    const [row] = await this.db
      .select()
      .from(rebatePrograms)
      .where(and(eq(rebatePrograms.companyId, companyId), eq(rebatePrograms.id, id)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That rebate programme does not exist.');
    return row;
  }

  async getView(companyId: string, id: string): Promise<RebateProgramView> {
    const rows = await this.list(companyId);
    const v = rows.find((r) => r.id === id);
    if (!v) throw new PricingConfigError('NOT_FOUND', 'That rebate programme does not exist.');
    return v;
  }

  timeline(id: string) {
    return this.decisions.timeline('rebate_program', id);
  }

  check(input: RebateProgramInput): { errors: RuleIssue[]; warnings: RuleIssue[] } {
    return checkRebateProgram(input);
  }

  // ── Changing ─────────────────────────────────────────────────────────────

  async create(
    companyId: string,
    input: RebateProgramInput & { description?: string | null },
    actor: Actor,
    reason: Why,
  ): Promise<RebateProgramRow> {
    const why = await this.why(companyId, reason);
    const code = this.normaliseCode(input.code);
    const checks = checkRebateProgram({ ...input, code });
    if (checks.errors.length)
      throw new PricingConfigError('INVALID', checks.errors[0]!.message, checks.errors);
    const [dup] = await this.db
      .select({ id: rebatePrograms.id })
      .from(rebatePrograms)
      .where(and(eq(rebatePrograms.companyId, companyId), eq(rebatePrograms.code, code)))
      .limit(1);
    if (dup)
      throw new PricingConfigError('DUPLICATE_CODE', `A rebate programme ${code} already exists.`);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(rebatePrograms)
        .values({
          companyId,
          code,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          period: input.period,
          tierMode: input.tierMode,
          tiers: [...input.tiers].sort((a, b) => a.from - b.from),
          scopes: input.scopes,
          target: input.target,
          validFrom: input.validFrom,
          validTo: input.validTo,
          createdBy: actor.id ?? 'system',
        })
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'rebate_program', id: row!.id },
          action: 'pricing.rebate_program_created',
          reason: why,
          to: 'draft',
          outcome: { code, period: input.period, tiers: input.tiers },
        },
        tx,
      );
      return row!;
    });
  }

  async update(
    companyId: string,
    id: string,
    input: RebateProgramInput & { description?: string | null },
    actor: Actor,
    reason: Why,
  ): Promise<RebateProgramRow> {
    const why = await this.why(companyId, reason);
    const before = await this.get(companyId, id);
    if (before.status === 'active' || before.status === 'retired')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        before.status === 'active'
          ? 'A programme in force cannot be edited. Pause it first.'
          : 'A retired programme cannot be edited.',
      );
    const checks = checkRebateProgram({ ...input, code: before.code });
    if (checks.errors.length)
      throw new PricingConfigError('INVALID', checks.errors[0]!.message, checks.errors);
    // Changing how a period is cut would leave existing totals filed under the wrong period.
    const hasTotals = await this.db
      .select({ n: sql<number>`1` })
      .from(rebateAccruals)
      .where(eq(rebateAccruals.programId, id))
      .limit(1);
    if (hasTotals.length > 0 && input.period !== before.period)
      throw new PricingConfigError(
        'LOCKED',
        'Purchases are already counted under this period length. Make a new programme to change it.',
      );
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(rebatePrograms)
        .set({
          name: input.name.trim(),
          description: input.description?.trim() || null,
          period: input.period,
          tierMode: input.tierMode,
          tiers: [...input.tiers].sort((a, b) => a.from - b.from),
          scopes: input.scopes,
          target: input.target,
          validFrom: input.validFrom,
          validTo: input.validTo,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(rebatePrograms.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'rebate_program', id },
          action: 'pricing.rebate_program_updated',
          reason: why,
          from: before.status,
          to: before.status,
          inputs: { tiers: before.tiers, tierMode: before.tierMode },
          outcome: { tiers: input.tiers, tierMode: input.tierMode, version: updated!.version },
        },
        tx,
      );
      return updated!;
    });
    this.rebates.invalidate(companyId);
    return row;
  }

  async activate(companyId: string, id: string, actor: Actor, reason: Why) {
    const p = await this.get(companyId, id);
    const checks = checkRebateProgram(toInput(p));
    if (checks.errors.length)
      throw new PricingConfigError('INVALID', checks.errors[0]!.message, checks.errors);
    return this.move(companyId, id, 'active', 'pricing.rebate_program_activated', actor, reason, [
      'draft',
      'paused',
    ]);
  }

  pause(companyId: string, id: string, actor: Actor, reason: Why) {
    return this.move(companyId, id, 'paused', 'pricing.rebate_program_paused', actor, reason, [
      'active',
    ]);
  }

  retire(companyId: string, id: string, actor: Actor, reason: Why) {
    return this.move(companyId, id, 'retired', 'pricing.rebate_program_retired', actor, reason, [
      'draft',
      'active',
      'paused',
    ]);
  }

  private async move(
    companyId: string,
    id: string,
    to: RebateProgramRow['status'],
    action: string,
    actor: Actor,
    reason: Why,
    from: RebateProgramRow['status'][],
  ) {
    const why = await this.why(companyId, reason);
    const p = await this.get(companyId, id);
    if (p.status === to) return p;
    if (!from.includes(p.status))
      throw new PricingConfigError('NOT_EDITABLE', `A ${p.status} programme cannot be made ${to}.`);
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(rebatePrograms)
        .set({ status: to, updatedAt: new Date() })
        .where(eq(rebatePrograms.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'rebate_program', id },
          action,
          reason: why,
          from: p.status,
          to,
        },
        tx,
      );
      return updated!;
    });
    this.rebates.invalidate(companyId);
    return row;
  }

  // ── Statements ───────────────────────────────────────────────────────────

  /** The periods that have totals, newest first. */
  async periods(
    companyId: string,
    id: string,
  ): Promise<Array<{ key: string; label: string; ended: boolean }>> {
    await this.get(companyId, id);
    const rows = await this.db
      .selectDistinct({ key: rebateBalances.periodKey })
      .from(rebateBalances)
      .where(eq(rebateBalances.programId, id));
    return rows
      .map((r) => r.key)
      .sort()
      .reverse()
      .map((key) => ({ key, label: periodLabel(key), ended: periodEnded(key) }));
  }

  /** What each customer has bought in a period and what that earns back. */
  async statement(companyId: string, id: string, period: string): Promise<Statement> {
    const p = await this.get(companyId, id);
    const balances = await this.db
      .select({
        customerId: rebateBalances.customerId,
        basis: rebateBalances.basis,
        name: customers.name,
        number: customers.number,
      })
      .from(rebateBalances)
      .innerJoin(customers, eq(customers.id, rebateBalances.customerId))
      .where(and(eq(rebateBalances.programId, id), eq(rebateBalances.periodKey, period)))
      .orderBy(desc(rebateBalances.basis))
      .limit(MAX_STATEMENT_ROWS + 1);
    const truncated = balances.length > MAX_STATEMENT_ROWS;
    const used = truncated ? balances.slice(0, MAX_STATEMENT_ROWS) : balances;
    const settled = used.length
      ? await this.db
          .select()
          .from(rebateSettlements)
          .where(
            and(
              eq(rebateSettlements.programId, id),
              eq(rebateSettlements.periodKey, period),
              inArray(rebateSettlements.status, ['pending', 'settled']),
            ),
          )
      : [];
    const bySettlement = new Map(settled.map((s) => [s.customerId, s]));
    const rows: StatementRow[] = used.map((b) => {
      const basis = num(b.basis);
      const s = bySettlement.get(b.customerId);
      return {
        customerId: b.customerId,
        customerName: b.name,
        customerNumber: b.number,
        basis,
        percent: effectivePercent(basis, p.tiers, p.tierMode),
        amount: rebateFor(basis, p.tiers, p.tierMode),
        next: toNextTier(basis, p.tiers),
        settlement: s ? { id: s.id, status: s.status, amount: num(s.amount) } : null,
      };
    });
    return {
      programId: id,
      periodKey: period,
      label: periodLabel(period),
      ended: periodEnded(period),
      rows,
      totalBasis: money(rows.reduce((n, r) => n + r.basis, 0)),
      totalAmount: money(rows.reduce((n, r) => n + r.amount, 0)),
      truncated,
    };
  }

  async listSettlements(companyId: string, programId?: string, limit = 100) {
    return this.db
      .select({
        id: rebateSettlements.id,
        programId: rebateSettlements.programId,
        programCode: rebatePrograms.code,
        customerId: rebateSettlements.customerId,
        customerName: customers.name,
        periodKey: rebateSettlements.periodKey,
        basis: rebateSettlements.basis,
        percent: rebateSettlements.percent,
        amount: rebateSettlements.amount,
        status: rebateSettlements.status,
        approvalStatus: rebateSettlements.approvalStatus,
        creditRef: rebateSettlements.creditRef,
        createdAt: rebateSettlements.createdAt,
        settledAt: rebateSettlements.settledAt,
      })
      .from(rebateSettlements)
      .innerJoin(rebatePrograms, eq(rebatePrograms.id, rebateSettlements.programId))
      .innerJoin(customers, eq(customers.id, rebateSettlements.customerId))
      .where(
        and(
          eq(rebateSettlements.companyId, companyId),
          programId ? eq(rebateSettlements.programId, programId) : undefined,
        ),
      )
      .orderBy(desc(rebateSettlements.createdAt))
      .limit(limit);
  }

  // ── Paying a rebate out ──────────────────────────────────────────────────

  private settlementRequest(companyId: string, s: RebateSettlementRow, programCode: string) {
    return {
      companyId,
      trigger: 'rebate.settle',
      documentId: s.id,
      branchId: null,
      requestedBy: s.requestedBy,
      amount: num(s.amount),
      snapshot: {
        programCode,
        periodKey: s.periodKey,
        basis: num(s.basis),
        percent: num(s.percent),
      },
    };
  }

  /**
   * Asks to pay a customer the rebate for a finished period. Held for approval when a workflow
   * says so; otherwise paid straight away.
   */
  async requestSettlement(
    companyId: string,
    input: { programId: string; customerId: string; periodKey: string },
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<
    | { outcome: 'settled'; settlementId: string }
    | { outcome: 'pending'; settlementId: string; message: string }
  > {
    const why = await this.why(companyId, reason);
    const p = await this.get(companyId, input.programId);
    if (!periodEnded(input.periodKey))
      throw new PricingConfigError(
        'NOT_EDITABLE',
        `${periodLabel(input.periodKey)} has not finished, so the total can still grow.`,
      );
    const [bal] = await this.db
      .select()
      .from(rebateBalances)
      .where(
        and(
          eq(rebateBalances.programId, input.programId),
          eq(rebateBalances.customerId, input.customerId),
          eq(rebateBalances.periodKey, input.periodKey),
        ),
      )
      .limit(1);
    const basis = num(bal?.basis);
    const amount = rebateFor(basis, p.tiers, p.tierMode);
    if (amount <= 0)
      throw new PricingConfigError(
        'INVALID',
        'This customer did not reach the first step, so there is nothing to pay back.',
      );
    const [customer] = await this.db
      .select({ accountType: customers.accountType, name: customers.name })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId)))
      .limit(1);
    if (!customer) throw new PricingConfigError('NOT_FOUND', 'That customer does not exist.');
    if (customer.accountType !== 'credit')
      throw new PricingConfigError(
        'INVALID',
        `${customer.name} pays at the invoice and has no account to credit. Rebates are credited to account customers.`,
      );

    const created = await withAfterCommit(this.db, async (tx) => {
      const [s] = await tx
        .insert(rebateSettlements)
        .values({
          companyId,
          programId: input.programId,
          customerId: input.customerId,
          periodKey: input.periodKey,
          basis: basis.toFixed(2),
          percent: effectivePercent(basis, p.tiers, p.tierMode).toFixed(4),
          amount: amount.toFixed(2),
          requestedBy: actor.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!s)
        throw new PricingConfigError(
          'CONFLICT',
          'A rebate for this customer and period is already settled or waiting for approval.',
        );
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'rebate_settlement', id: s.id },
          action: 'pricing.rebate_settlement_requested',
          reason: why,
          to: 'pending',
          inputs: { programCode: p.code, periodKey: input.periodKey, basis, amount },
        },
        tx,
      );
      const outcome = await this.approvals.submit(this.settlementRequest(companyId, s, p.code), tx);
      if (outcome.required) {
        await tx
          .update(rebateSettlements)
          .set({ approvalStatus: 'pending' })
          .where(eq(rebateSettlements.id, s.id));
      }
      return { s, held: outcome.required };
    });
    if (!created.held) {
      await this.settle(companyId, created.s.id, actor, why);
      return { outcome: 'settled', settlementId: created.s.id };
    }
    return {
      outcome: 'pending',
      settlementId: created.s.id,
      message:
        'Sent for approval. The credit is posted to the customer as soon as it is approved; follow it under My requests.',
    };
  }

  /** The facts an approver's conditions look at, as they are now. */
  async approvalSnapshot(db: Pick<DrizzleDb, 'select'>, id: string) {
    const [s] = await db
      .select({ amount: rebateSettlements.amount })
      .from(rebateSettlements)
      .where(eq(rebateSettlements.id, id))
      .limit(1);
    return { amount: num(s?.amount) };
  }

  /**
   * Posts the credit. Called directly, or by the approval workflow in the approver's transaction.
   * The customer's open invoices are reduced oldest first; a rebate larger than what the customer
   * owes cannot be posted, because there is nowhere to hold the rest.
   */
  async settle(
    companyId: string,
    id: string,
    actor: Actor,
    reason: Why,
    writer?: Tx,
  ): Promise<RebateSettlementRow> {
    const why = await this.why(companyId, reason);
    const run = async (tx: Tx) => {
      const [s] = await tx
        .select()
        .from(rebateSettlements)
        .where(and(eq(rebateSettlements.id, id), eq(rebateSettlements.companyId, companyId)))
        .for('update');
      if (!s) throw new PricingConfigError('NOT_FOUND', 'That settlement does not exist.');
      if (s.status === 'settled') return s;
      if (s.status !== 'pending')
        throw new PricingConfigError('NOT_EDITABLE', `A ${s.status} settlement cannot be paid.`);
      const [p] = await tx.select().from(rebatePrograms).where(eq(rebatePrograms.id, s.programId));
      const [bal] = await tx
        .select()
        .from(rebateBalances)
        .where(
          and(
            eq(rebateBalances.programId, s.programId),
            eq(rebateBalances.customerId, s.customerId),
            eq(rebateBalances.periodKey, s.periodKey),
          ),
        );
      const now = rebateFor(num(bal?.basis), p!.tiers, p!.tierMode);
      if (Math.abs(now - num(s.amount)) > 0.004)
        throw new PricingConfigError(
          'CONFLICT',
          `The customer's purchases changed after this was requested (it was ${num(s.amount).toFixed(2)}, it is now ${now.toFixed(2)}). Refuse it and ask again.`,
        );
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, s.customerId))
        .for('update');
      const open = await tx
        .select()
        .from(customerLedgerEntries)
        .where(
          and(
            eq(customerLedgerEntries.customerId, s.customerId),
            eq(customerLedgerEntries.documentType, 'invoice'),
            ne(customerLedgerEntries.remainingAmount, '0'),
          ),
        )
        .orderBy(asc(customerLedgerEntries.createdAt))
        .for('update');
      const amount = num(s.amount);
      const openTotal = money(open.reduce((n, e) => n + num(e.remainingAmount), 0));
      if (amount > openTotal + 0.004)
        throw new PricingConfigError(
          'INVALID',
          `${customer!.name} owes ${openTotal.toFixed(2)} on open invoices, less than the rebate of ${amount.toFixed(2)}. Settle it once there is enough owing to credit.`,
        );
      const ref = `RBT-${s.periodKey}-${s.id.slice(0, 8).toUpperCase()}`;
      const today = businessDate();
      const currency = open[0]?.currency ?? 'KES';
      const [credit] = await tx
        .insert(customerLedgerEntries)
        .values({
          companyId,
          customerId: s.customerId,
          documentType: 'rebate_credit',
          documentNo: ref,
          description: `Rebate ${p!.code} ${periodLabel(s.periodKey)}`,
          amount: (-amount).toFixed(2),
          remainingAmount: '0',
          kraTransmissionStatus: 'not_applicable',
          postingDate: today,
          currency,
        })
        .returning({ id: customerLedgerEntries.id });
      // Its history: the credit, and each invoice it settled (so open amounts always equal history).
      const history: (typeof customerDetailedEntries.$inferInsert)[] = [
        { companyId, customerId: s.customerId, ledgerEntryId: credit!.id, entryType: 'initial', amount: (-amount).toFixed(2), postingDate: today },
      ];
      let left = amount;
      for (const e of open) {
        if (left <= 0.004) break;
        const remaining = num(e.remainingAmount);
        const applied = Math.min(remaining, left);
        await tx
          .update(customerLedgerEntries)
          .set({ remainingAmount: money(remaining - applied).toFixed(2) })
          .where(eq(customerLedgerEntries.id, e.id));
        const base = { companyId, customerId: s.customerId, entryType: 'application' as const, postingDate: today };
        history.push(
          { ...base, ledgerEntryId: e.id, amount: (-applied).toFixed(2), appliedToEntryId: credit!.id },
          { ...base, ledgerEntryId: credit!.id, amount: applied.toFixed(2), appliedToEntryId: e.id },
        );
        left -= applied;
      }
      await tx.insert(customerDetailedEntries).values(history);
      // Once the ledger is live the rebate's cost reaches it; queued here, in the same transaction.
      const { getContainer } = await import('@/server/di/container');
      await getContainer().finance.salesPosting.enqueue(tx, { companyId, kind: 'rebate_credit', subjectId: credit!.id });
      await tx
        .update(customers)
        .set({
          balance: Math.max(0, money(num(customer!.balance) - amount)).toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(customers.id, s.customerId));
      const [done] = await tx
        .update(rebateSettlements)
        .set({ status: 'settled', approvalStatus: 'none', creditRef: ref, settledAt: new Date() })
        .where(eq(rebateSettlements.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'rebate_settlement', id },
          action: 'pricing.rebate_settled',
          reason: why,
          from: 'pending',
          to: 'settled',
          outcome: { creditRef: ref, amount },
        },
        tx,
      );
      return done!;
    };
    return writer ? run(writer) : this.db.transaction(run);
  }

  /** What an approval does to a settlement that is refused, reopened or withdrawn. */
  async setSettlementState(
    tx: Pick<DrizzleDb, 'update'>,
    id: string,
    state: 'rejected' | 'cancelled',
  ) {
    await tx
      .update(rebateSettlements)
      .set(
        state === 'rejected'
          ? { status: 'rejected', approvalStatus: 'rejected' }
          : { status: 'cancelled', approvalStatus: 'none' },
      )
      .where(and(eq(rebateSettlements.id, id), eq(rebateSettlements.status, 'pending')));
  }

  async requestedWith(tx: Pick<DrizzleDb, 'select'>, id: string) {
    const [row] = await tx
      .select({
        code: decisionLog.reasonCode,
        text: decisionLog.reasonText,
        actorId: decisionLog.actorId,
      })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.subjectType, 'rebate_settlement'),
          eq(decisionLog.subjectId, id),
          eq(decisionLog.action, 'pricing.rebate_settlement_requested'),
        ),
      )
      .orderBy(desc(decisionLog.occurredAt))
      .limit(1);
    return row ?? null;
  }

  async settlementView(id: string) {
    const [s] = await this.db
      .select({
        id: rebateSettlements.id,
        amount: rebateSettlements.amount,
        periodKey: rebateSettlements.periodKey,
        basis: rebateSettlements.basis,
        percent: rebateSettlements.percent,
        code: rebatePrograms.code,
        name: rebatePrograms.name,
        customer: customers.name,
      })
      .from(rebateSettlements)
      .innerJoin(rebatePrograms, eq(rebatePrograms.id, rebateSettlements.programId))
      .innerJoin(customers, eq(customers.id, rebateSettlements.customerId))
      .where(eq(rebateSettlements.id, id))
      .limit(1);
    return s ?? null;
  }
}
