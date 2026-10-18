import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { exchangeRates, financeSettings, fxRevaluations, customerReceipts, ledgerRegisters, type ExchangeRateRow, type FxRevaluationRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { formatAmount, parseAmount } from './domain/amount';
import { baseValue, checkRate, pickRate, revaluationDifference, toCentsRounded } from './domain/fx';
import type { PostingRequest } from './domain/types';
import type { PostingEngine, Tx } from './engine';
import { FinanceError, type FinanceContext } from './errors';
import type { PostingSetupService } from './posting-setup-service';
import type { CreditPolicyService } from './receivables/credit-policy-service';

import { has } from '@/lib/values';

type Reader = Pick<DrizzleDb, 'select' | 'execute'>;
/** Revaluations of what customers' wallets hold are kept beside the receivables ones in the same record, under this prefix. */
const WALLET_KEY = 'wallet:';
const CARD_KEY = 'giftcards:';
const SYSTEM = { canPostSoftClosed: true, canPostControlAccounts: true };

export interface LedgerEntryForRate {
  id: string;
  currency: string | null;
  postingDate: string;
}

/**
 * Foreign currency: the rate that applies on a day, the rate a ledger entry is carried at, and the revaluation of what
 * customers owe (or are owed) in a currency that has moved. Rates are set by hand, one per currency per day, and a day that
 * has passed stands for good.
 */
export class FxService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly setup: PostingSetupService,
    private readonly policies: CreditPolicyService,
  ) {}

  // ── rates ────────────────────────────────────────────────────────────────

  private async settings(w: Reader, companyId: string) {
    const [s] = await w.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    return s;
  }

  async setRate(ctx: FinanceContext, input: { currency: string; effectiveOn: string; rate: string; note?: string | null }): Promise<ExchangeRateRow> {
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new FinanceError('CURRENCY_INVALID', 'A currency is three letters, such as USD.');
    const problem = checkRate(input.rate);
    if (problem !== null) throw new FinanceError('RATE_INVALID', problem);
    const today = businessDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveOn)) throw new FinanceError('DATE_INVALID', 'The day is not a date.');
    if (input.effectiveOn < today) throw new FinanceError('DATE_PAST', 'A rate cannot be set for a day that has already passed: documents of that day have been valued already.');
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    if (input.effectiveOn > horizon) throw new FinanceError('DATE_FAR', 'A rate can be set at most 14 days ahead.');
    return await this.db.transaction(async (tx) => {
      const s = await this.settings(tx, ctx.companyId);
      if (currency === s.baseCurrency) throw new FinanceError('CURRENCY_IS_BASE', `${currency} is the currency of the books; it needs no rate.`);
      const rate = Number(input.rate).toFixed(8);
      const [existing] = await tx.select().from(exchangeRates).where(and(eq(exchangeRates.companyId, ctx.companyId), eq(exchangeRates.currency, currency), eq(exchangeRates.effectiveOn, input.effectiveOn))).for('update');
      let row: ExchangeRateRow;
      if (existing) {
        await this.refuseIfUsed(tx, ctx.companyId, currency, existing.effectiveOn);
        [row] = await tx.update(exchangeRates).set({ rate, note: input.note ?? null, createdBy: ctx.actor.id ?? 'system' }).where(eq(exchangeRates.id, existing.id)).returning();
      } else {
        [row] = await tx.insert(exchangeRates).values({ companyId: ctx.companyId, currency, effectiveOn: input.effectiveOn, rate, note: input.note ?? null, createdBy: ctx.actor.id ?? 'system' }).returning();
      }
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'exchange_rate', id: row.id }, action: existing ? 'finance.exchange_rate_changed' : 'finance.exchange_rate_set', actor: ctx.actor, inputs: { origin: ctx.origin, currency, day: input.effectiveOn }, outcome: { rate, before: existing?.rate ?? null } }, tx);
      return row;
    });
  }

  /** A rate that something has been posted with is the value of that posting: it stands. */
  private async refuseIfUsed(tx: Reader, companyId: string, currency: string, from: string): Promise<void> {
    const [used] = await tx.select({ id: ledgerRegisters.id }).from(ledgerRegisters).where(and(eq(ledgerRegisters.companyId, companyId), eq(ledgerRegisters.currency, currency), sql`${ledgerRegisters.postingDate} >= ${from}::date`)).limit(1);
    if (used) throw new FinanceError('RATE_IN_USE', `Entries in ${currency} have already been posted with this rate, so it cannot be changed or removed. Set a new rate from a later day instead.`);
  }

  async removeRate(ctx: FinanceContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(exchangeRates).where(and(eq(exchangeRates.companyId, ctx.companyId), eq(exchangeRates.id, id))).for('update');
      if (!r) throw new FinanceError('NOT_FOUND', 'That rate does not exist.');
      if (r.effectiveOn < businessDate()) throw new FinanceError('DATE_PAST', 'A rate from a day that has passed stands for good.');
      await this.refuseIfUsed(tx, ctx.companyId, r.currency, r.effectiveOn);
      await tx.delete(exchangeRates).where(eq(exchangeRates.id, id));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'exchange_rate', id }, action: 'finance.exchange_rate_removed', actor: ctx.actor, inputs: { origin: ctx.origin, currency: r.currency, day: r.effectiveOn }, outcome: { rate: r.rate } }, tx);
    });
  }

  /** One page of rates, newest day first. The cursor is the day and the currency of the last row. */
  async rates(companyId: string, f: { currency?: string; before?: string; limit?: number } = {}) {
    const limit = Math.min(f.limit ?? 50, 200);
    const [day = '', cur = ''] = (f.before ?? '').split('|');
    const cursor = /^\d{4}-\d{2}-\d{2}$/.test(day) && /^[A-Z]{3}$/.test(cur) ? { day, cur } : null;
    const rows = await this.db
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.companyId, companyId),
          has(f.currency) ? eq(exchangeRates.currency, f.currency.toUpperCase()) : undefined,
          cursor === null ? undefined : sql`(${exchangeRates.effectiveOn}, ${exchangeRates.currency}) < (${cursor.day}::date, ${cursor.cur})`,
        ),
      )
      .orderBy(desc(exchangeRates.effectiveOn), desc(exchangeRates.currency))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { rows: page, nextBefore: more ? `${last.effectiveOn}|${last.currency}` : null };
  }

  /** The currencies that have a rate, each with its newest, for the top of the screen. */
  async latest(companyId: string) {
    return await this.db
      .selectDistinctOn([exchangeRates.currency])
      .from(exchangeRates)
      .where(and(eq(exchangeRates.companyId, companyId), sql`${exchangeRates.effectiveOn} <= ${businessDate()}::date`))
      .orderBy(exchangeRates.currency, desc(exchangeRates.effectiveOn));
  }

  /** The rate in force on a date, or null when none had started. */
  async rateOn(w: Reader, companyId: string, currency: string, date: string): Promise<string | null> {
    const rows = await w
      .select({ effectiveOn: exchangeRates.effectiveOn, rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.companyId, companyId), eq(exchangeRates.currency, currency.toUpperCase()), sql`${exchangeRates.effectiveOn} <= ${date}::date`))
      .orderBy(desc(exchangeRates.effectiveOn))
      .limit(1);
    return pickRate(rows, date);
  }

  /** The same, or a refusal that says which rate is missing and where to set it. */
  async requireRate(w: Reader, companyId: string, currency: string, date: string): Promise<string> {
    const rate = await this.rateOn(w, companyId, currency, date);
    if (rate === null) throw new FinanceError('NO_RATE', `There is no exchange rate for ${currency.toUpperCase()} on or before ${date}. Set it under Finance → Exchange rates.`);
    return rate;
  }

  /**
   * The rate each of these ledger entries is carried at in the books: a receipt (or a use of a wallet) at the rate it was entered with, anything else
   * at the rate of its day, and anything that already existed when the books went live at the rate on that day. With a date
   * given, every entry is valued at that day's rate instead (the opening balance at go-live). Lenient leaves out an entry whose
   * currency has no rate rather than refusing.
   */
  async carryingRates(w: Reader, companyId: string, entries: readonly LedgerEntryForRate[], forceDate?: string, lenient = false): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const s = await this.settings(w, companyId);
    const foreign = entries.filter((e) => e.currency !== null && e.currency.toUpperCase() !== s.baseCurrency);
    for (const e of entries) if (!foreign.includes(e)) out.set(e.id, '1');
    if (foreign.length === 0) return out;
    const receiptRates = new Map<string, string>();
    for (let i = 0; i < foreign.length; i += 1000) {
      const ids = foreign.slice(i, i + 1000).map((e) => e.id);
      const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
      const rows = await w.execute<{ ledger_entry_id: string; rate: string }>(sql`SELECT ledger_entry_id::text, rate FROM customer_receipts WHERE ledger_entry_id IN (${list})`);
      for (const r of rows) receiptRates.set(r.ledger_entry_id, r.rate);
      // Paying from a wallet is like paying with a receipt: at the rate the wallet was carried at.
      const used = await w.execute<{ ledger_entry_id: string; rate: string }>(sql`SELECT ledger_entry_id::text, rate FROM wallet_entries WHERE entry_type = 'utilisation' AND ledger_entry_id IN (${list})`);
      for (const r of used) receiptRates.set(r.ledger_entry_id, r.rate);
      // Returned refund money kept as credit is carried at the rate it was booked at when it came back.
      const kept = await w.execute<{ ledger_entry_id: string; rate: string }>(sql`SELECT e.id::text AS ledger_entry_id, r.rate::text AS rate FROM customer_ledger_entries e JOIN ledger_registers r ON r.id = e.register_id WHERE e.document_type = 'refund' AND upper(r.currency) = upper(e.currency) AND e.id IN (${list})`);
      for (const r of kept) receiptRates.set(r.ledger_entry_id, r.rate);
    }
    const cache = new Map<string, string | null>();
    const day = async (currency: string, date: string) => {
      const key = `${currency}|${date}`;
      if (!cache.has(key)) cache.set(key, await this.rateOn(w, companyId, currency, date));
      return cache.get(key) ?? null;
    };
    const goLive = s.salesGlGoLive;
    for (const e of foreign) {
      const currency = (e.currency ?? '').toUpperCase();
      const beforeBooks = goLive !== null && e.postingDate < goLive;
      const lookupDate = forceDate ?? (beforeBooks ? goLive : e.postingDate);
      const own = forceDate !== undefined || beforeBooks ? undefined : receiptRates.get(e.id);
      const rate = own ?? (await day(currency, lookupDate));
      if (rate === null) {
        if (lenient) continue;
        throw new FinanceError('NO_RATE', `There is no exchange rate for ${currency} on or before ${lookupDate}. Set it under Finance → Exchange rates.`);
      }
      out.set(e.id, rate);
    }
    return out;
  }

  // ── revaluation ──────────────────────────────────────────────────────────

  /**
   * Values what customers owe (and are owed) in each foreign currency at today's rate, against what the books carry it at, and
   * posts the difference to exchange gains or losses by customer posting group. It is undone the next day by `reverseDue`, so
   * the real difference is only recognised when a customer pays. Once for a day.
   */
  async revalue(ctx: FinanceContext): Promise<{ id: string; netCents: number; groups: number }> {
    const asOf = businessDate();
    return await this.db.transaction(async (tx) => {
      const s = await this.settings(tx, ctx.companyId);
      if (s.salesGlGoLive === null) throw new FinanceError('NOT_LIVE', 'Sales are not in the general ledger yet, so there is nothing to revalue.');
      const [again] = await tx.select({ id: fxRevaluations.id }).from(fxRevaluations).where(and(eq(fxRevaluations.companyId, ctx.companyId), eq(fxRevaluations.asOf, asOf)));
      if (again) throw new FinanceError('ALREADY_DONE', `The balances were already revalued today (${asOf}).`);
      const open = await tx.execute<{ id: string; remaining: string; currency: string; posting_date: string; customer_id: string }>(sql`
        SELECT e.id::text, e.remaining_amount::text AS remaining, e.currency, e.posting_date::text, e.customer_id::text
        FROM customer_ledger_entries e
        WHERE e.company_id = ${ctx.companyId}::uuid AND e.currency IS NOT NULL AND upper(e.currency) <> ${s.baseCurrency} AND e.remaining_amount <> 0`);
      const rows = [...open];
      const held = [...(await tx.execute<{ customer_id: string; currency: string; balance: string; base_value: string }>(sql`
        SELECT w.customer_id::text, w.currency, w.balance::text, w.base_value::text
        FROM customer_wallets w
        WHERE w.company_id = ${ctx.companyId}::uuid AND upper(w.currency) <> ${s.baseCurrency} AND (w.balance > 0 OR w.base_value <> 0)`))];
      const cards = [...(await tx.execute<{ currency: string; balance: string; rate: string }>(sql`
        SELECT c.currency, c.balance::text, c.rate FROM gift_cards c
        WHERE c.company_id = ${ctx.companyId}::uuid AND upper(c.currency) <> ${s.baseCurrency} AND c.balance > 0`))];
      if (rows.length === 0 && held.length === 0 && cards.length === 0) throw new FinanceError('NOTHING_TO_REVALUE', 'Nobody owes, or is owed, anything in a foreign currency.');
      const carrying = await this.carryingRates(tx, ctx.companyId, rows.map((r) => ({ id: r.id, currency: r.currency, postingDate: r.posting_date })));
      const rates: Record<string, string> = {};
      const byGroup = new Map<string, bigint>();
      const groupOf = new Map<string, string>();
      for (const r of rows) {
        const currency = r.currency.toUpperCase();
        rates[currency] ??= await this.requireRate(tx, ctx.companyId, currency, asOf);
        if (!groupOf.has(r.customer_id)) groupOf.set(r.customer_id, (await this.policies.forCustomer(tx, ctx.companyId, r.customer_id, asOf)).groupCode);
        const diff = revaluationDifference(r.remaining, carrying.get(r.id) ?? '1', rates[currency]);
        const group = groupOf.get(r.customer_id) ?? s.defaultCustomerGroup;
        byGroup.set(group, (byGroup.get(group) ?? 0n) + diff);
      }
      // Wallets are owed to customers: worth more today means a loss, so the sign is the other way round.
      const heldByGroup = new Map<string, bigint>();
      for (const h of held) {
        const currency = h.currency.toUpperCase();
        rates[currency] ??= await this.requireRate(tx, ctx.companyId, currency, asOf);
        if (!groupOf.has(h.customer_id)) groupOf.set(h.customer_id, (await this.policies.forCustomer(tx, ctx.companyId, h.customer_id, asOf)).groupCode);
        const group = groupOf.get(h.customer_id) ?? s.defaultCustomerGroup;
        heldByGroup.set(group, (heldByGroup.get(group) ?? 0n) + (baseValue(h.balance, rates[currency]) - parseAmount(h.base_value)));
      }
      // Gift cards are owed to their holders too, and sit in the default group's account.
      let cardsDiff = 0n;
      for (const c of cards) {
        const currency = c.currency.toUpperCase();
        rates[currency] ??= await this.requireRate(tx, ctx.companyId, currency, asOf);
        cardsDiff += baseValue(c.balance, rates[currency]) - baseValue(c.balance, c.rate);
      }
      const groups: FxRevaluationRow['groups'] = {};
      let net = 0n;
      if (cardsDiff !== 0n) {
        const group = s.defaultCustomerGroup;
        const [liability, gain, loss] = await Promise.all([this.setup.resolveCustomer(ctx.companyId, group, 'gift_card_liability'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_gain'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_loss')]).catch((e: unknown) => {
          throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
        });
        const up = cardsDiff > 0n;
        const amount = formatAmount(up ? cardsDiff : -cardsDiff);
        const { registerId } = await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `fx-revaluation:${asOf}:giftcards:${group}`,
            postingDate: asOf,
            documentType: 'fx_revaluation',
            documentNo: `FXR-${asOf}-G-${group}`,
            description: `Gift cards revalued at ${Object.entries(rates).map(([c, r]) => `${c} ${r}`).join(', ')}`,
            currency: s.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: up ? loss.accountId : liability.accountId, debit: amount, credit: '0', description: up ? 'Exchange loss on gift cards' : 'Gift cards worth less' },
              { accountId: up ? liability.accountId : gain.accountId, debit: '0', credit: amount, description: up ? 'Gift cards worth more' : 'Exchange gain on gift cards' },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'fx_revaluation', id: `${asOf}:giftcards:${group}` },
            postedBy: 'engine',
          },
          SYSTEM,
          tx,
        );
        groups[`${CARD_KEY}${group}`] = { net: formatAmount(cardsDiff), register: registerId, reversal: null };
        net -= cardsDiff;
      }
      for (const [group, diff] of heldByGroup) {
        if (diff === 0n) continue;
        const [deposits, gain, loss] = await Promise.all([this.setup.resolveCustomer(ctx.companyId, group, 'customer_deposits'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_gain'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_loss')]).catch((e: unknown) => {
          throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
        });
        const up = diff > 0n;
        const amount = formatAmount(up ? diff : -diff);
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `fx-revaluation:${asOf}:wallet:${group}`,
          postingDate: asOf,
          documentType: 'fx_revaluation',
          documentNo: `FXR-${asOf}-W-${group}`,
          description: `Customer wallets revalued at ${Object.entries(rates).map(([c, r]) => `${c} ${r}`).join(', ')} (${group})`,
          currency: s.baseCurrency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: up ? loss.accountId : deposits.accountId, debit: amount, credit: '0', description: up ? 'Exchange loss on customer wallets' : 'Customer wallets worth less', ...(up ? {} : { sourceLedger: 'wallet' as const }) },
            { accountId: up ? deposits.accountId : gain.accountId, debit: '0', credit: amount, description: up ? 'Customer wallets worth more' : 'Exchange gain on customer wallets', ...(up ? { sourceLedger: 'wallet' as const } : {}) },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'fx_revaluation', id: `${asOf}:wallet:${group}` },
          postedBy: 'engine',
        };
        const { registerId } = await this.engine.post(req, SYSTEM, tx);
        groups[`${WALLET_KEY}${group}`] = { net: formatAmount(diff), register: registerId, reversal: null };
        net -= diff;
      }
      for (const [group, diff] of byGroup) {
        if (diff === 0n) continue;
        const [receivables, gain, loss] = await Promise.all([this.setup.resolveCustomer(ctx.companyId, group, 'receivables'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_gain'), this.setup.resolveCustomer(ctx.companyId, group, 'fx_loss')]).catch((e: unknown) => {
          throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
        });
        const up = diff > 0n;
        const amount = formatAmount(up ? diff : -diff);
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `fx-revaluation:${asOf}:${group}`,
          postingDate: asOf,
          documentType: 'fx_revaluation',
          documentNo: `FXR-${asOf}-${group}`,
          description: `Foreign balances revalued at ${Object.entries(rates).map(([c, r]) => `${c} ${r}`).join(', ')} (${group})`,
          currency: s.baseCurrency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: up ? receivables.accountId : loss.accountId, debit: amount, credit: '0', description: up ? 'Receivables worth more' : 'Exchange loss on balances', ...(up ? { sourceLedger: 'customer' as const } : {}) },
            { accountId: up ? gain.accountId : receivables.accountId, debit: '0', credit: amount, description: up ? 'Exchange gain on balances' : 'Receivables worth less', ...(up ? {} : { sourceLedger: 'customer' as const }) },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'fx_revaluation', id: `${asOf}:${group}` },
          postedBy: 'engine',
        };
        const { registerId } = await this.engine.post(req, SYSTEM, tx);
        groups[group] = { net: formatAmount(diff), register: registerId, reversal: null };
        net += diff;
      }
      const [row] = await tx.insert(fxRevaluations).values({ companyId: ctx.companyId, asOf, rates, net: formatAmount(net), groups, createdBy: ctx.actor.id ?? 'system' }).returning();
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'fx_revaluation', id: row.id }, action: 'finance.fx_revalued', actor: ctx.actor, inputs: { origin: ctx.origin, rates }, outcome: { net: formatAmount(net), groups: Object.keys(groups).length } }, tx);
      return { id: row.id, netCents: toCentsRounded(net), groups: Object.keys(groups).length };
    });
  }

  /** Undoes, today, every revaluation of an earlier day that is still standing. Safe to run again. */
  async reverseDue(now: Date = new Date()): Promise<number> {
    const today = businessDate(now);
    const due = await this.db.select().from(fxRevaluations).where(and(isNull(fxRevaluations.reversedAt), sql`${fxRevaluations.asOf} < ${today}::date`)).orderBy(asc(fxRevaluations.asOf));
    let done = 0;
    for (const rev of due) {
      try {
        await this.db.transaction(async (tx) => {
          const [locked] = await tx.select().from(fxRevaluations).where(and(eq(fxRevaluations.id, rev.id), isNull(fxRevaluations.reversedAt))).for('update');
          if (!locked) return;
          const ctx: FinanceContext = { companyId: rev.companyId, actor: { type: 'job', id: 'fx-revaluation' }, origin: { surface: 'jobs/fx', action: 'reverse_revaluation' } };
          const groups: FxRevaluationRow['groups'] = {};
          for (const [group, g] of Object.entries(locked.groups)) {
            const reversed = await this.engine.reverse({ companyId: rev.companyId, registerId: g.register, postingDate: today, reasonCode: 'PERIOD_ROLLOVER', reasonText: `Revaluation of ${locked.asOf} undone`, origin: ctx.origin, permissions: SYSTEM, tx });
            groups[group] = { ...g, reversal: reversed.registerId };
          }
          await tx.update(fxRevaluations).set({ groups, reversedAt: new Date() }).where(eq(fxRevaluations.id, rev.id));
          await this.decisions.record({ companyId: rev.companyId, subject: { type: 'fx_revaluation', id: rev.id }, action: 'finance.fx_revaluation_undone', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { as_of: locked.asOf } }, tx);
          done += 1;
        });
      } catch (error) {
        console.error('[fx] a revaluation could not be undone', rev.id, error instanceof Error ? error.message : error);
      }
    }
    return done;
  }

  /** What the standing (not yet undone) revaluations added to each customer posting group, in 4-decimal scaled text. */
  async outstandingByGroup(w: Reader, companyId: string): Promise<Map<string, bigint>> {
    const rows = await w.select({ groups: fxRevaluations.groups }).from(fxRevaluations).where(and(eq(fxRevaluations.companyId, companyId), isNull(fxRevaluations.reversedAt)));
    const out = new Map<string, bigint>();
    for (const r of rows) for (const [group, g] of Object.entries(r.groups)) if (!group.startsWith(WALLET_KEY) && !group.startsWith(CARD_KEY)) out.set(group, (out.get(group) ?? 0n) + BigInt(g.net.replace('.', '')));
    return out;
  }

  /** What the standing revaluations added to what customers' wallets are owed, by posting group (the liability going up is positive). */
  async outstandingWalletByGroup(w: Reader, companyId: string): Promise<Map<string, bigint>> {
    const rows = await w.select({ groups: fxRevaluations.groups }).from(fxRevaluations).where(and(eq(fxRevaluations.companyId, companyId), isNull(fxRevaluations.reversedAt)));
    const out = new Map<string, bigint>();
    for (const r of rows) for (const [key, g] of Object.entries(r.groups)) if (key.startsWith(WALLET_KEY)) out.set(key.slice(WALLET_KEY.length), (out.get(key.slice(WALLET_KEY.length)) ?? 0n) + BigInt(g.net.replace('.', '')));
    return out;
  }

  /** What the standing revaluations added to what gift cards are owed, by posting group (the liability going up is positive). */
  async outstandingCardsByGroup(w: Reader, companyId: string): Promise<Map<string, bigint>> {
    const rows = await w.select({ groups: fxRevaluations.groups }).from(fxRevaluations).where(and(eq(fxRevaluations.companyId, companyId), isNull(fxRevaluations.reversedAt)));
    const out = new Map<string, bigint>();
    for (const r of rows) for (const [key, g] of Object.entries(r.groups)) if (key.startsWith(CARD_KEY)) out.set(key.slice(CARD_KEY.length), (out.get(key.slice(CARD_KEY.length)) ?? 0n) + BigInt(g.net.replace('.', '')));
    return out;
  }

  async revaluations(companyId: string, limit = 20) {
    return await this.db.select().from(fxRevaluations).where(eq(fxRevaluations.companyId, companyId)).orderBy(desc(fxRevaluations.asOf)).limit(limit);
  }

  /** Foreign-currency receipts hold their own rate; this tells it, for a screen that wants to show it. */
  async receiptRate(w: Reader, ledgerEntryId: string): Promise<string | null> {
    const [r] = await w.select({ rate: customerReceipts.rate }).from(customerReceipts).where(eq(customerReceipts.ledgerEntryId, ledgerEntryId));
    return r?.rate ?? null;
  }
}

export type { Tx };
