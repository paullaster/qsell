import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  businessPostingGroups,
  currencies,
  customerPostingGroups,
  financeSettings,
  generalPostingSetup,
  glAccounts,
  productPostingGroups,
  type GlAccountRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { compareAccountNo, isValidTotaling, validateChart } from './domain/chart';
import { findTemplate } from './domain/templates';
import { FinanceError, type FinanceContext } from './errors';
import type { FiscalService } from './fiscal-service';

export interface AccountInput {
  no: string;
  name: string;
  type: GlAccountRow['type'];
  category: GlAccountRow['category'];
  subcategory?: string | null;
  normalBalance: 'debit' | 'credit';
  directPosting?: boolean;
  postingSource?: 'manual' | 'engine_only';
  currencyPolicy?: string;
  dimensionRule?: 'none' | 'required' | 'forbidden';
  totaling?: string | null;
  indent?: number;
}

export class FinanceSetupService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly fiscal: FiscalService,
  ) {}

  async getSettings(companyId: string) {
    const [row] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    return row ?? null;
  }

  async updateSettings(
    ctx: FinanceContext,
    input: { postingFrom: string | null; postingTo: string | null },
  ) {
    const s = await this.getSettings(ctx.companyId);
    if (!s) throw new FinanceError('NOT_SET_UP', 'Apply a chart of accounts first.');
    if (input.postingFrom && input.postingTo && input.postingFrom > input.postingTo) {
      throw new FinanceError('WINDOW_INVALID', 'The posting window ends before it starts.');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(financeSettings)
        .set({ postingFrom: input.postingFrom, postingTo: input.postingTo, updatedAt: sql`now()` })
        .where(eq(financeSettings.companyId, ctx.companyId));
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'finance_settings', id: ctx.companyId },
          action: 'finance.settings_changed',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, before: { from: s.postingFrom, to: s.postingTo } },
          outcome: { from: input.postingFrom, to: input.postingTo },
        },
        tx,
      );
    });
  }

  // ── chart of accounts ──────────────────────────────────────────────────────

  async listAccounts(companyId: string, q?: string) {
    const where = q
      ? and(
          eq(glAccounts.companyId, companyId),
          or(ilike(glAccounts.no, `%${q}%`), ilike(glAccounts.name, `%${q}%`)),
        )
      : eq(glAccounts.companyId, companyId);
    const rows = await this.db.select().from(glAccounts).where(where).orderBy(asc(glAccounts.no));
    return rows.sort((a, b) => compareAccountNo(a.no, b.no));
  }

  async getAccount(companyId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(glAccounts)
      .where(and(eq(glAccounts.companyId, companyId), eq(glAccounts.id, id)));
    return row ?? null;
  }

  private check(input: AccountInput) {
    if (input.no.trim() === '') throw new FinanceError('NO_REQUIRED', 'The account needs a number.');
    if (input.name.trim() === '') throw new FinanceError('NAME_REQUIRED', 'The account needs a name.');
    if (input.type === 'posting' && !input.category) {
      throw new FinanceError('CATEGORY_REQUIRED', 'A posting account needs a category.');
    }
    if ((input.type === 'total' || input.type === 'end_total') && !input.totaling) {
      throw new FinanceError('TOTALING_REQUIRED', 'A total account needs a range to add up, like 1000..1999.');
    }
    if (input.totaling && !isValidTotaling(input.totaling)) {
      throw new FinanceError('TOTALING_INVALID', `"${input.totaling}" is not a valid range.`);
    }
    if (input.type !== 'posting' && input.directPosting) {
      throw new FinanceError('NOT_POSTABLE', 'Only posting accounts can allow posting.');
    }
  }

  async createAccount(ctx: FinanceContext, input: AccountInput) {
    this.check(input);
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: glAccounts.id })
        .from(glAccounts)
        .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.no, input.no.trim())));
      if (dup) throw new FinanceError('DUPLICATE_NO', `Account ${input.no} already exists.`);
      const [row] = await tx
        .insert(glAccounts)
        .values({
          companyId: ctx.companyId,
          no: input.no.trim(),
          name: input.name.trim(),
          type: input.type,
          category: input.type === 'posting' ? input.category : null,
          subcategory: input.subcategory ?? null,
          normalBalance: input.normalBalance,
          directPosting: input.type === 'posting' ? (input.directPosting ?? true) : false,
          postingSource: input.postingSource ?? 'manual',
          currencyPolicy: input.currencyPolicy ?? 'any',
          dimensionRule: input.dimensionRule ?? 'none',
          totaling: input.totaling ?? null,
          indent: input.indent ?? 0,
        })
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'gl_account', id: row!.id },
          action: 'finance.account_created',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { no: row!.no, name: row!.name, type: row!.type },
        },
        tx,
      );
      return row!;
    });
  }

  async updateAccount(ctx: FinanceContext, id: string, input: AccountInput) {
    this.check(input);
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(glAccounts)
        .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, id)))
        .for('update');
      if (!before) throw new FinanceError('NOT_FOUND', 'That account does not exist.');
      if (before.usedAt !== null) {
        if (
          before.no !== input.no.trim() ||
          before.type !== input.type ||
          before.normalBalance !== input.normalBalance ||
          before.currencyPolicy !== (input.currencyPolicy ?? 'any')
        ) {
          throw new FinanceError(
            'ACCOUNT_USED',
            'This account has postings, so its number, type, normal balance and currency cannot change. Block it and create a new one instead.',
          );
        }
      } else if (before.no !== input.no.trim()) {
        const [dup] = await tx
          .select({ id: glAccounts.id })
          .from(glAccounts)
          .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.no, input.no.trim())));
        if (dup) throw new FinanceError('DUPLICATE_NO', `Account ${input.no} already exists.`);
      }
      const [row] = await tx
        .update(glAccounts)
        .set({
          no: input.no.trim(),
          name: input.name.trim(),
          type: input.type,
          category: input.type === 'posting' ? input.category : null,
          subcategory: input.subcategory ?? null,
          normalBalance: input.normalBalance,
          directPosting: input.type === 'posting' ? (input.directPosting ?? true) : false,
          postingSource: input.postingSource ?? 'manual',
          currencyPolicy: input.currencyPolicy ?? 'any',
          dimensionRule: input.dimensionRule ?? 'none',
          totaling: input.totaling ?? null,
          indent: input.indent ?? 0,
          updatedAt: sql`now()`,
        })
        .where(eq(glAccounts.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'gl_account', id },
          action: 'finance.account_changed',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, before: { no: before.no, name: before.name, type: before.type } },
          outcome: { no: row!.no, name: row!.name, type: row!.type },
        },
        tx,
      );
      return row!;
    });
  }

  async setBlocked(ctx: FinanceContext, id: string, blocked: boolean, reason?: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(glAccounts)
        .set({ blocked, updatedAt: sql`now()` })
        .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, id)))
        .returning({ no: glAccounts.no });
      if (!row) throw new FinanceError('NOT_FOUND', 'That account does not exist.');
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'gl_account', id },
          action: blocked ? 'finance.account_blocked' : 'finance.account_unblocked',
          actor: ctx.actor,
          reason: { text: reason ?? null },
          inputs: { origin: ctx.origin },
          outcome: { no: row.no },
        },
        tx,
      );
    });
  }

  async deleteAccount(ctx: FinanceContext, id: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(glAccounts)
        .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, id)));
      if (!row) throw new FinanceError('NOT_FOUND', 'That account does not exist.');
      if (row.usedAt !== null) {
        throw new FinanceError('ACCOUNT_USED', 'This account has postings and cannot be deleted. Block it instead.');
      }
      try {
        await tx.delete(glAccounts).where(eq(glAccounts.id, id));
      } catch {
        throw new FinanceError(
          'ACCOUNT_IN_SETUP',
          'This account is used in posting setup. Remove it from the setup first.',
        );
      }
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'gl_account', id },
          action: 'finance.account_deleted',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { no: row.no, name: row.name },
        },
        tx,
      );
    });
  }

  // ── templates ──────────────────────────────────────────────────────────────

  /**
   * Imports a chart template once. The company owns every row afterwards; applying again is
   * refused while any account exists, so a template can never overwrite someone's chart.
   */
  async applyTemplate(ctx: FinanceContext, code: string, opts: { fiscalYearStart?: string } = {}) {
    const template = findTemplate(code);
    if (!template) throw new FinanceError('TEMPLATE_UNKNOWN', `There is no template "${code}".`);
    const problems = validateChart(template.accounts);
    if (problems.length > 0) {
      throw new FinanceError('TEMPLATE_INVALID', problems[0]!.message, problems.map((p) => ({ message: p.message })));
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'finance-template:' + ctx.companyId}))`);
      const [any] = await tx
        .select({ id: glAccounts.id })
        .from(glAccounts)
        .where(eq(glAccounts.companyId, ctx.companyId))
        .limit(1);
      if (any) {
        throw new FinanceError(
          'CHART_EXISTS',
          'This company already has a chart of accounts. A template can only be applied to an empty chart.',
        );
      }
      const inserted = await tx
        .insert(glAccounts)
        .values(
          template.accounts.map((a) => ({
            companyId: ctx.companyId,
            no: a.no,
            name: a.name,
            type: a.type,
            category: a.category,
            subcategory: a.subcategory ?? null,
            normalBalance: a.normalBalance,
            directPosting: a.directPosting,
            postingSource: a.postingSource,
            totaling: a.totaling ?? null,
            indent: a.indent,
          })),
        )
        .returning({ id: glAccounts.id, no: glAccounts.no });
      const byNo = new Map(inserted.map((r) => [r.no, r.id]));
      const acct = (no: string): string => {
        const id = byNo.get(no);
        if (!id) throw new FinanceError('TEMPLATE_INVALID', `The template refers to account ${no}, which it does not define.`);
        return id;
      };

      const biz = await tx
        .insert(businessPostingGroups)
        .values(template.businessGroups.map((g) => ({ companyId: ctx.companyId, ...g })))
        .returning();
      const prod = await tx
        .insert(productPostingGroups)
        .values(template.productGroups.map((g) => ({ companyId: ctx.companyId, ...g })))
        .returning();
      const bizId = new Map(biz.map((g) => [g.code, g.id]));
      const prodId = new Map(prod.map((g) => [g.code, g.id]));
      await tx.insert(generalPostingSetup).values(
        template.generalSetup.map((r) => ({
          companyId: ctx.companyId,
          businessGroupId: bizId.get(r.business)!,
          productGroupId: prodId.get(r.product)!,
          effectiveFrom: '2000-01-01',
          salesAccountId: acct(r.sales),
          salesReturnsAccountId: acct(r.salesReturns),
          salesDiscountAccountId: acct(r.salesDiscount),
          cogsAccountId: acct(r.cogs),
          inventoryAdjustmentAccountId: acct(r.inventoryAdjustment),
        })),
      );
      await tx.insert(customerPostingGroups).values(
        template.customerGroups.map((g) => ({
          companyId: ctx.companyId,
          code: g.code,
          name: g.name,
          receivablesAccountId: acct(g.receivables),
          customerDepositsAccountId: acct(g.customerDeposits),
          refundsPayableAccountId: acct(g.refundsPayable),
          paymentDiscountAccountId: acct(g.paymentDiscount),
          writeOffAccountId: acct(g.writeOff),
          roundingAccountId: acct(g.rounding),
          fxGainAccountId: acct(g.fxGain),
          fxLossAccountId: acct(g.fxLoss),
          serviceChargeAccountId: acct(g.serviceCharge),
        })),
      );

      const baseCurrency = await this.baseCurrencyFor(tx, template.baseCurrency);
      await tx
        .insert(financeSettings)
        .values({
          companyId: ctx.companyId,
          baseCurrency,
          chartTemplate: template.code,
          chartAppliedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: financeSettings.companyId,
          set: { baseCurrency, chartTemplate: template.code, chartAppliedAt: new Date(), updatedAt: sql`now()` },
        });

      const year = opts.fiscalYearStart ?? `${new Date().getUTCFullYear()}-${String(template.fiscalYearStartMonth).padStart(2, '0')}-01`;
      await this.fiscal.createYearIn(tx, ctx, { startsOn: year, shape: template.calendarShape });

      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'finance_settings', id: ctx.companyId },
          action: 'finance.chart_template_applied',
          actor: ctx.actor,
          policy: { id: `chart-template:${template.code}`, version: template.version },
          inputs: { origin: ctx.origin },
          outcome: { template: template.code, accounts: inserted.length, baseCurrency },
        },
        tx,
      );
      return { accounts: inserted.length, baseCurrency };
    });
  }

  /** The company's base currency if one is marked, else the template's suggestion. */
  private async baseCurrencyFor(db: Pick<DrizzleDb, 'select'>, suggestion: string): Promise<string> {
    const [base] = await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.isBaseCurrency, true)).limit(1);
    return base?.code ?? suggestion;
  }
}
