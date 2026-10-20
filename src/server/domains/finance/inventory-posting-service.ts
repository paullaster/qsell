import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { financeInventoryEvents, financeSettings, glAccounts, products, type FinanceInventoryEventRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { fromCents, toCents } from './domain/receivables';
import { planChange, readinessChecks, type Check, type Side } from './domain/inventory-posting';
import type { PostingRequest } from './domain/types';
import type { PostingEngine, Tx } from './engine';
import { FinanceError, type FinanceContext } from './errors';
import type { PostingSetupService } from './posting-setup-service';

import { has, required } from '@/lib/values';

const MAX_BACKOFF_MINUTES = 60;
const SYSTEM = { canPostSoftClosed: true, canPostControlAccounts: true };
const PURPOSES: Side[] = ['inventory', 'cogs', 'inventory_adjustment', 'inventory_clearing'];

/**
 * Stock at cost in the books. The database writes down every change in what stock is worth the moment it happens
 * (see migration 0054); this service takes those changes to the general ledger, retrying with a growing delay so a
 * set-up mistake can never stop a sale or a delivery. Nothing is posted before the go-live date, and at go-live the
 * stock then on hand comes in as an opening balance against an equity account.
 */
export class InventoryPostingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly setup: PostingSetupService,
  ) {}

  private async settings(w: DrizzleDb | Tx, companyId: string) {
    const [s] = await w.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    return s;
  }

  // ── processing ───────────────────────────────────────────────────────────

  /** Posts what is due, oldest first. Safe to run from several workers at once. */
  async processDue(limit = 200): Promise<{ posted: number; failed: number }> {
    const due = await this.db
      .select({ id: financeInventoryEvents.id })
      .from(financeInventoryEvents)
      .where(and(inArray(financeInventoryEvents.status, ['pending', 'failed']), lte(financeInventoryEvents.nextAttemptAt, sql`now()`)))
      .orderBy(asc(financeInventoryEvents.id))
      .limit(limit);
    let posted = 0;
    let failed = 0;
    for (const { id } of due) {
      if (await this.attempt(id)) posted += 1;
      else failed += 1;
    }
    return { posted, failed };
  }

  /** One attempt. True when the event is now posted, skipped or was already done. */
  async attempt(id: number): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(financeInventoryEvents)
          .where(and(eq(financeInventoryEvents.id, id), inArray(financeInventoryEvents.status, ['pending', 'failed'])))
          .for('update', { skipLocked: true });
        if (!row) return true;
        const outcome = await this.postRow(tx, row);
        await tx
          .update(financeInventoryEvents)
          .set({ status: outcome.kind, registerId: outcome.registerId, lastError: outcome.kind === 'skipped' ? outcome.reason : null, postedAt: new Date(), attempts: sql`${financeInventoryEvents.attempts} + 1` })
          .where(eq(financeInventoryEvents.id, id));
        return true;
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Unknown error').slice(0, 500);
      await this.db
        .update(financeInventoryEvents)
        .set({
          status: 'failed',
          lastError: message,
          attempts: sql`${financeInventoryEvents.attempts} + 1`,
          nextAttemptAt: sql`now() + make_interval(mins => LEAST(${MAX_BACKOFF_MINUTES}, power(2, LEAST(${financeInventoryEvents.attempts}, 6))::int))`,
        })
        .where(eq(financeInventoryEvents.id, id));
      return false;
    }
  }

  private async postRow(tx: Tx, row: FinanceInventoryEventRow): Promise<{ kind: 'posted'; registerId: string } | { kind: 'skipped'; registerId: null; reason: string }> {
    const s = await this.settings(tx, row.companyId);
    if (s.inventoryGlGoLive === null || row.eventDate < s.inventoryGlGoLive) return { kind: 'skipped', registerId: null, reason: 'The change happened before stock went into the books.' };
    const plan = planChange({ kind: row.kind, changeType: row.changeType, valueCents: toCents(row.value) });
    if (plan === null) return { kind: 'skipped', registerId: null, reason: 'The goods had no cost, so there is nothing to post.' };
    const accounts = await this.accountsFor(row.companyId, s, row.eventDate, [plan.debit, plan.credit]);
    const [product] = await tx.select({ name: products.name, sku: products.sku }).from(products).where(eq(products.id, row.productId));
    const what = product === undefined ? row.productId : `${product.sku} ${product.name}`;
    const req: PostingRequest = {
      companyId: row.companyId,
      idempotencyKey: `inventory-event:${String(row.id)}`,
      postingDate: row.eventDate,
      documentType: row.kind === 'movement' ? 'stock_movement' : 'stock_revaluation',
      documentNo: `STK-${String(row.id)}`,
      description: `${plan.label}: ${what} (${String(Math.abs(row.quantity))} × ${row.unitCost})`,
      currency: s.baseCurrency,
      rate: '1',
      rateSource: 'base',
      lines: [
        { accountId: required(accounts.get(plan.debit)), debit: fromCents(plan.cents), credit: '0', description: `${plan.label}: ${what}` },
        { accountId: required(accounts.get(plan.credit)), debit: '0', credit: fromCents(plan.cents), description: `${plan.label}: ${what}` },
      ],
      chainKey: 'general',
      origin: { surface: 'jobs/inventory-posting', action: 'post_stock_event' },
      source: { type: 'inventory_event', id: String(row.id) },
      postedBy: 'engine',
    };
    const { registerId } = await this.engine.post(req, SYSTEM, tx);
    return { kind: 'posted', registerId };
  }

  /** The account for each side, from the general posting setup of the company's default groups on the day. */
  private async accountsFor(companyId: string, s: Awaited<ReturnType<InventoryPostingService['settings']>>, date: string, sides: Side[]): Promise<Map<Side, string>> {
    const out = new Map<Side, string>();
    for (const side of new Set(sides)) {
      try {
        out.set(side, (await this.setup.resolveGeneral(companyId, s.defaultBusinessGroup, s.defaultProductGroup, side, date)).accountId);
      } catch (error) {
        throw new FinanceError('POSTING_SETUP_MISSING', error instanceof Error ? error.message : 'Posting setup is incomplete.');
      }
    }
    return out;
  }

  // ── readiness and go-live ────────────────────────────────────────────────

  async readiness(companyId: string): Promise<Check[]> {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) return readinessChecks({ financeSetUp: false, missing: [], live: false, failed: 0 });
    const missing: string[] = [];
    const today = businessDate();
    for (const purpose of PURPOSES) {
      try {
        await this.setup.resolveGeneral(companyId, s.defaultBusinessGroup, s.defaultProductGroup, purpose, today);
      } catch {
        missing.push(purpose);
      }
    }
    const [failed] = await this.db.select({ n: sql<number>`count(*)::int` }).from(financeInventoryEvents).where(and(eq(financeInventoryEvents.companyId, companyId), eq(financeInventoryEvents.status, 'failed')));
    return readinessChecks({ financeSetUp: true, missing, live: s.inventoryGlGoLive !== null, failed: failed?.n ?? 0 });
  }

  /** What the goods on the shelves are worth at cost, in cents: units on hand × cost per unit, product by product. */
  async stockValueCents(w: DrizzleDb | Tx = this.db): Promise<number> {
    const [row] = await w.execute<{ cents: string }>(sql`SELECT COALESCE(SUM(ROUND(stock_quantity::numeric * cost_price * 100)), 0)::numeric(30,0)::text AS cents FROM products WHERE stock_quantity <> 0`);
    return Number(row?.cents ?? 0);
  }

  /**
   * Starts stock in the books. The stock on hand today comes in at cost against an equity account (Dr inventory, Cr the
   * opening-balance account); every change after that posts as it happens. The products table is locked for the moment it
   * takes, so no sale can slip between "counted" and "switched on" and be lost.
   */
  async goLive(ctx: FinanceContext, input: { offsetAccountId: string }): Promise<{ date: string; openingCents: number }> {
    const checks = await this.readiness(ctx.companyId);
    const blocking = checks.filter((c) => c.blocking && !c.ok);
    if (blocking.length > 0) throw new FinanceError('NOT_READY', `Not ready: ${blocking.map((b) => b.label).join('; ')}.`);
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE`);
      const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId)).for('update');
      if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
      if (has(s.inventoryGlGoLive)) throw new FinanceError('ALREADY_LIVE', `Stock has been in the books since ${s.inventoryGlGoLive}.`);
      const [offset] = await tx.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, input.offsetAccountId)));
      if (offset?.type !== 'posting' || offset.blocked) throw new FinanceError('OFFSET_INVALID', 'Choose a postable equity account for the opening balance.');
      if (offset.category !== 'equity') throw new FinanceError('OFFSET_INVALID', `${offset.no} ${offset.name} is not an equity account.`);
      const today = businessDate();
      const openingCents = await this.stockValueCents(tx);
      if (openingCents !== 0) {
        const inventory = (await this.accountsFor(ctx.companyId, s, today, ['inventory'])).get('inventory');
        const debit = openingCents > 0;
        await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: 'opening-inventory',
            postingDate: today,
            documentType: 'opening_balance',
            documentNo: 'OPEN-STOCK',
            description: 'Opening stock at cost at go-live',
            currency: s.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: required(inventory), debit: debit ? fromCents(openingCents) : '0', credit: debit ? '0' : fromCents(-openingCents), description: 'Opening stock at cost' },
              { accountId: offset.id, debit: debit ? '0' : fromCents(-openingCents), credit: debit ? fromCents(openingCents) : '0', description: 'Opening stock offset' },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'inventory_go_live', id: ctx.companyId },
            postedBy: 'engine',
          },
          SYSTEM,
          tx,
        );
      }
      await tx.update(financeSettings).set({ inventoryGlGoLive: today, updatedAt: new Date() }).where(eq(financeSettings.companyId, ctx.companyId));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'finance_settings', id: ctx.companyId }, action: 'finance.inventory_go_live', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { date: today, opening: fromCents(openingCents), offset: offset.no } }, tx);
      return { date: today, openingCents };
    });
  }

  // ── looking after it ─────────────────────────────────────────────────────

  /** Makes a failed change due now, after the setup was fixed. */
  async retry(ctx: FinanceContext, id: number): Promise<boolean> {
    await this.db
      .update(financeInventoryEvents)
      .set({ nextAttemptAt: new Date() })
      .where(and(eq(financeInventoryEvents.companyId, ctx.companyId), eq(financeInventoryEvents.id, id), eq(financeInventoryEvents.status, 'failed')));
    return await this.attempt(id);
  }

  /**
   * The books against the shelves: the inventory account's balance against units × cost over all products, and the changes
   * still waiting that explain a gap. A difference that the waiting changes do not explain needs looking at.
   */
  async reconciliation(companyId: string) {
    const s = await this.settings(this.db, companyId);
    const live = s.inventoryGlGoLive !== null;
    const inventory = live ? (await this.accountsFor(companyId, s, businessDate(), ['inventory'])).get('inventory') : undefined;
    const [gl, shelves, waiting] = await Promise.all([
      inventory === undefined
        ? Promise.resolve(0)
        : this.db.execute<{ net: string }>(sql`SELECT COALESCE(SUM(base_debit - base_credit), 0)::text AS net FROM gl_account_balances WHERE company_id = ${companyId}::uuid AND account_id = ${inventory}::uuid`).then((r) => toCents(Number(r[0]?.net ?? 0).toFixed(2))),
      this.stockValueCents(),
      this.db
        .select({ n: sql<string>`COALESCE(SUM(${financeInventoryEvents.value}), 0)::text`, count: sql<number>`count(*)::int` })
        .from(financeInventoryEvents)
        .where(and(eq(financeInventoryEvents.companyId, companyId), inArray(financeInventoryEvents.status, ['pending', 'failed']))),
    ]);
    const waitingCents = toCents(waiting[0]?.n ?? '0');
    return { live, since: s.inventoryGlGoLive, glCents: gl, shelvesCents: shelves, waitingCents, waitingCount: waiting[0]?.count ?? 0, diffCents: gl + waitingCents - shelves };
  }

  async overview(companyId: string) {
    const [counts, failed, recent] = await Promise.all([
      this.db
        .select({ status: financeInventoryEvents.status, n: sql<number>`count(*)::int` })
        .from(financeInventoryEvents)
        .where(eq(financeInventoryEvents.companyId, companyId))
        .groupBy(financeInventoryEvents.status),
      this.db
        .select()
        .from(financeInventoryEvents)
        .where(and(eq(financeInventoryEvents.companyId, companyId), eq(financeInventoryEvents.status, 'failed')))
        .orderBy(desc(financeInventoryEvents.id))
        .limit(50),
      this.db.select().from(financeInventoryEvents).where(and(eq(financeInventoryEvents.companyId, companyId), eq(financeInventoryEvents.status, 'posted'))).orderBy(desc(financeInventoryEvents.id)).limit(20),
    ]);
    return { counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), failed, recent };
  }
}
