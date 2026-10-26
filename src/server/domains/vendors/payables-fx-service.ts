import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { financeSettings, payablesRevaluations, vendorLedgerEntries, vendorPostingGroups, vendors, type PayablesRevaluationRow } from '@/server/db/drizzle/schema';
import { baseCents } from '@/lib/vendor-fx';
import { fromCents, toCents } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { FxService } from '@/server/domains/finance/fx-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';

const ENGINE = { canPostSoftClosed: true, canPostControlAccounts: true };

/**
 * What the business owes vendors in a foreign currency, valued at today's rate against what the books carry it at (the rate each
 * invoice was booked at). The difference is posted to exchange gains or losses by vendor posting group and undone the next day,
 * so the real difference is recognised only when an invoice is paid. Once for a day.
 */
export class PayablesFxService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly engine: PostingEngine,
    private readonly fx: FxService,
  ) {}

  async revalue(ctx: FinanceContext, now: Date = new Date()): Promise<{ id: string; netCents: number; groups: number }> {
    const asOf = businessDate(now);
    return await this.db.transaction(async (tx) => {
      const [fs] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
      if (fs === undefined) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
      const [again] = await tx.select({ id: payablesRevaluations.id }).from(payablesRevaluations).where(and(eq(payablesRevaluations.companyId, ctx.companyId), eq(payablesRevaluations.asOf, asOf)));
      if (again !== undefined) throw new FinanceError('ALREADY_DONE', `What is owed in other currencies was already revalued today (${asOf}).`);
      const open = await tx
        .select({ id: vendorLedgerEntries.id, remaining: vendorLedgerEntries.remainingAmount, currency: vendorLedgerEntries.currency, rate: vendorLedgerEntries.rate, groupId: vendors.postingGroupId })
        .from(vendorLedgerEntries)
        .innerJoin(vendors, eq(vendors.id, vendorLedgerEntries.vendorId))
        .where(and(eq(vendorLedgerEntries.companyId, ctx.companyId), sql`${vendorLedgerEntries.currency} <> ${fs.baseCurrency}`, sql`${vendorLedgerEntries.remainingAmount} <> 0`, sql`${vendorLedgerEntries.documentType} <> 'advance'`));
      if (open.length === 0) throw new FinanceError('NOTHING_TO_REVALUE', 'Nothing is owed to vendors in another currency.');
      const rates: Record<string, string> = {};
      const byGroup = new Map<string, number>();
      for (const e of open) {
        rates[e.currency] ??= await this.fx.requireRate(tx, ctx.companyId, e.currency, asOf);
        const rate = rates[e.currency] ?? '1';
        const cents = toCents(e.remaining);
        const diff = baseCents(cents, rate) - baseCents(cents, e.rate);
        const group = e.groupId ?? '';
        byGroup.set(group, (byGroup.get(group) ?? 0) + diff);
      }
      const groups: PayablesRevaluationRow['groups'] = {};
      let net = 0;
      for (const [groupId, diff] of byGroup) {
        if (diff === 0) continue;
        const [g] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, groupId));
        if (g?.payablesAccountId == null) throw new FinanceError('POSTING_GROUP', 'A vendor posting group with foreign balances has no payables account.');
        const loss = diff > 0;
        const account = loss ? g.fxLossAccountId : g.fxGainAccountId;
        if (account === null) throw new FinanceError('POSTING_GROUP', `The posting group ${g.code} has no exchange ${loss ? 'loss' : 'gain'} account. Choose one in the ordering rules.`);
        const amount = fromCents(Math.abs(diff));
        const { registerId } = await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `payables-revaluation:${asOf}:${groupId}`,
            postingDate: asOf,
            documentType: 'payables_revaluation',
            documentNo: `PFX-${asOf}-${g.code}`,
            description: `Amounts owed to vendors revalued at ${Object.entries(rates).map(([c, r]) => `${c} ${r}`).join(', ')} (${g.code})`,
            currency: fs.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: loss ? account : g.payablesAccountId, debit: amount, credit: '0', description: loss ? 'Exchange loss on what is owed to vendors' : 'What is owed to vendors is worth less', ...(loss ? {} : { sourceLedger: 'vendor' }) },
              { accountId: loss ? g.payablesAccountId : account, debit: '0', credit: amount, description: loss ? 'What is owed to vendors is worth more' : 'Exchange gain on what is owed to vendors', ...(loss ? { sourceLedger: 'vendor' } : {}) },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'payables_revaluation', id: `${asOf}:${groupId}` },
            postedBy: 'engine',
          },
          ENGINE,
          tx,
        );
        groups[groupId] = { net: fromCents(diff), register: registerId, reversal: null };
        net += diff;
      }
      if (Object.keys(groups).length === 0) throw new FinanceError('NOTHING_TO_REVALUE', 'Today’s rates leave what is owed in other currencies worth what the books carry it at.');
      const [made] = await tx.insert(payablesRevaluations).values({ companyId: ctx.companyId, asOf, rates, net: fromCents(net), groups, createdBy: ctx.actor.id ?? 'system' }).returning({ id: payablesRevaluations.id });
      return { id: made?.id ?? '', netCents: net, groups: Object.keys(groups).length };
    });
  }

  /** Undoes the revaluations of earlier days that are still standing. Returns how many were undone. */
  async reverseDue(now: Date = new Date()): Promise<number> {
    const today = businessDate(now);
    const due = await this.db.select().from(payablesRevaluations).where(and(isNull(payablesRevaluations.reversedAt), sql`${payablesRevaluations.asOf} < ${today}::date`)).orderBy(asc(payablesRevaluations.asOf));
    let done = 0;
    for (const rev of due) {
      try {
        await this.db.transaction(async (tx) => {
          const [locked] = await tx.select().from(payablesRevaluations).where(and(eq(payablesRevaluations.id, rev.id), isNull(payablesRevaluations.reversedAt))).for('update');
          if (locked === undefined) return;
          const groups: PayablesRevaluationRow['groups'] = {};
          for (const [group, g] of Object.entries(locked.groups)) {
            const reversed = await this.engine.reverse({ companyId: rev.companyId, registerId: g.register, postingDate: today, reasonCode: 'PERIOD_ROLLOVER', reasonText: `Revaluation of ${locked.asOf} undone`, origin: { surface: 'jobs/payables-fx', action: 'reverse_revaluation' }, permissions: ENGINE, tx });
            groups[group] = { ...g, reversal: reversed.registerId };
          }
          await tx.update(payablesRevaluations).set({ groups, reversedAt: new Date() }).where(eq(payablesRevaluations.id, rev.id));
          done += 1;
        });
      } catch (error) {
        console.error('[payables-fx] a revaluation could not be undone', rev.id, error instanceof Error ? error.message : error);
      }
    }
    return done;
  }

  /** What the standing revaluations added to what is owed, by vendor posting group (a loss, owing more, is positive), in cents. */
  async standingByGroup(companyId: string): Promise<Map<string, number>> {
    const rows = await this.db.select({ groups: payablesRevaluations.groups }).from(payablesRevaluations).where(and(eq(payablesRevaluations.companyId, companyId), isNull(payablesRevaluations.reversedAt)));
    const out = new Map<string, number>();
    for (const r of rows) for (const [group, g] of Object.entries(r.groups)) out.set(group, (out.get(group) ?? 0) + toCents(g.net));
    return out;
  }

  async last(companyId: string) {
    const [r] = await this.db.select().from(payablesRevaluations).where(eq(payablesRevaluations.companyId, companyId)).orderBy(sql`${payablesRevaluations.asOf} DESC`).limit(1);
    return r === undefined ? null : { id: r.id, asOf: r.asOf, netCents: toCents(r.net), reversed: r.reversedAt !== null, rates: r.rates };
  }
}
