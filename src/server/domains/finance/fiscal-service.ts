import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { accountingPeriods, fiscalYears } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { addDays, addMonths, checkPeriodsTile, generatePeriods, type CalendarShape } from './domain/periods';
import { periodTransition } from './domain/periods-status';
import type { PeriodStatus } from './domain/types';
import { FinanceError, type FinanceContext } from './errors';

import { has } from '@/lib/has';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export class FiscalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async listYears(companyId: string) {
    const [years, periods] = await Promise.all([
      this.db.select().from(fiscalYears).where(eq(fiscalYears.companyId, companyId)).orderBy(asc(fiscalYears.startsOn)),
      this.db.select().from(accountingPeriods).where(eq(accountingPeriods.companyId, companyId)).orderBy(asc(accountingPeriods.startsOn)),
    ]);
    return years.map((y) => ({ ...y, periods: periods.filter((p) => p.fiscalYearId === y.id) }));
  }

  async createYear(ctx: FinanceContext, input: { startsOn: string; shape: CalendarShape }) {
    return await this.db.transaction((tx) => this.createYearIn(tx, ctx, input));
  }

  /** Creates a fiscal year and its periods in the caller's transaction. */
  async createYearIn(tx: Tx, ctx: FinanceContext, input: { startsOn: string; shape: CalendarShape }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) {
      throw new FinanceError('DATE_INVALID', 'The fiscal year start is not a date.');
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`finance-calendar:${  ctx.companyId}`}))`);
    const endsOn = addDays(addMonths(input.startsOn, 12), -1);
    const [clash] = await tx
      .select({ code: fiscalYears.code })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, ctx.companyId), lte(fiscalYears.startsOn, endsOn), gte(fiscalYears.endsOn, input.startsOn)))
      .limit(1);
    if (clash) {
      throw new FinanceError('YEAR_OVERLAP', `This overlaps fiscal year ${clash.code}.`);
    }
    const periods = generatePeriods(input.startsOn, input.shape);
    const problems = checkPeriodsTile(periods);
    if (problems.length > 0) throw new FinanceError('PERIODS_INVALID', problems[0]);

    const code = `FY${input.startsOn.slice(0, 4)}${input.startsOn.slice(5, 7) === '01' ? '' : `-${  input.startsOn.slice(5, 7)}`}`;
    const [year] = await tx
      .insert(fiscalYears)
      .values({ companyId: ctx.companyId, code, startsOn: input.startsOn, endsOn, shape: input.shape })
      .returning();
    await tx.insert(accountingPeriods).values(
      periods.map((p) => ({
        companyId: ctx.companyId,
        fiscalYearId: year.id,
        no: p.no,
        name: p.name,
        startsOn: p.startsOn,
        endsOn: p.endsOn,
      })),
    );
    await this.decisions.record(
      {
        companyId: ctx.companyId,
        subject: { type: 'fiscal_year', id: year.id },
        action: 'finance.fiscal_year_created',
        actor: ctx.actor,
        inputs: { origin: ctx.origin },
        outcome: { code, startsOn: input.startsOn, endsOn, shape: input.shape, periods: periods.length },
      },
      tx,
    );
    return year;
  }

  /** The permission needed to take a period from its current status to `to`, or null if illegal. */
  async requiredPermission(companyId: string, periodId: string, to: PeriodStatus) {
    const [p] = await this.db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.companyId, companyId), eq(accountingPeriods.id, periodId)));
    if (!p) throw new FinanceError('NOT_FOUND', 'That period does not exist.');
    return { period: p, transition: periodTransition(p.status, to) };
  }

  async setStatus(ctx: FinanceContext, periodId: string, to: PeriodStatus, reason?: string) {
    await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(accountingPeriods)
        .where(and(eq(accountingPeriods.companyId, ctx.companyId), eq(accountingPeriods.id, periodId)))
        .for('update');
      if (!p) throw new FinanceError('NOT_FOUND', 'That period does not exist.');
      const t = periodTransition(p.status, to);
      if (!t) {
        throw new FinanceError(
          'TRANSITION_ILLEGAL',
          p.status === 'locked' ? 'A locked period can never be changed.' : `A period cannot go from ${p.status} to ${to}.`,
        );
      }
      if (t.reasonRequired && !has((reason ?? '').trim())) {
        throw new FinanceError('REASON_REQUIRED', 'A reason is required for this change.');
      }
      await tx
        .update(accountingPeriods)
        .set({ status: to, statusChangedAt: sql`now()`, statusChangedBy: ctx.actor.id })
        .where(eq(accountingPeriods.id, periodId));
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'accounting_period', id: periodId },
          action: 'finance.period_status_changed',
          actor: ctx.actor,
          from: p.status,
          to,
          reason: { text: reason ?? null },
          inputs: { origin: ctx.origin, period: p.name, permissionUsed: t.permission },
        },
        tx,
      );
    });
  }
}
