import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { stockDocuments, stockIntegrityRuns, stockReservations, stockSettings } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { StockError } from './errors';
import type { StockLocationService } from './locations';
import type { ShadowReport, StockShadow } from './shadow';

export type LedgerMode = 'off' | 'shadow' | 'ledger';

export interface IntegrityRunView {
  at: string;
  trigger: string;
  ok: boolean;
  ranBy: string | null;
  report: ShadowReport | null;
}

export interface LedgerStatus {
  mode: LedgerMode;
  backfillDone: boolean;
  /** The newest comparison, if any has been made. */
  lastRun: IntegrityRunView | null;
  /** What stands in the way of going back to the old way. */
  open: { holds: number; transfersOnTheWay: number };
}

function modeOf(ledger: boolean, shadow: boolean): LedgerMode {
  if (ledger) return 'ledger';
  return shadow ? 'shadow' : 'off';
}

/** Thrown inside the switch's transaction to undo it, carrying the check that found the difference. */
class Refused extends Error {
  constructor(readonly report: ShadowReport) {
    super('The two sides differ');
  }
}

const differences = (r: ShadowReport): number => r.onHandDiffers + r.reservedDiffers + r.ledgerDiffers + r.negative + r.reservationsDiffer + r.journalDiffers;

/**
 * Moves a company between keeping stock the old way, mirroring it into the new ledger (the shadow), and keeping it in the new
 * ledger. Switching over is one transaction that briefly holds off changes to products, gives the orders reserved the old way their
 * holds, compares everything one last time and only then flips; if anything differs, nothing changes. Going back is refused while
 * the new ledger holds promises or stock on its way that the old way could not settle.
 * Design: docs/architecture/stock-locations.md §10 and §22.
 */
export class StockCutover {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shadow: StockShadow,
    private readonly locations: StockLocationService,
    private readonly decisionLog: DecisionLog,
  ) {}

  async status(companyId: string): Promise<LedgerStatus> {
    const s = await this.shadow.status(companyId);
    const [mode] = await this.db.select({ ledger: stockSettings.ledgerMode }).from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
    const [run] = await this.db.select().from(stockIntegrityRuns).where(eq(stockIntegrityRuns.companyId, companyId)).orderBy(desc(stockIntegrityRuns.ranAt), desc(stockIntegrityRuns.id)).limit(1);
    const holds = await this.db.select({ n: sql<number>`count(*)::int` }).from(stockReservations).where(and(eq(stockReservations.companyId, companyId), inArray(stockReservations.state, ['held', 'partly_consumed'])));
    const way = await this.db.select({ n: sql<number>`count(*)::int` }).from(stockDocuments).where(and(eq(stockDocuments.companyId, companyId), eq(stockDocuments.kind, 'transfer'), inArray(stockDocuments.state, ['shipped', 'partly_received'])));
    return {
      mode: modeOf(mode?.ledger === true, s.shadowWrite),
      backfillDone: s.backfillDoneAt !== null,
      lastRun: run === undefined ? null : { at: run.ranAt.toISOString(), trigger: run.trigger, ok: run.ok, ranBy: run.ranBy, report: run.report as unknown as ShadowReport },
      open: { holds: holds[0]?.n ?? 0, transfersOnTheWay: way[0]?.n ?? 0 },
    };
  }

  /** Step one: start mirroring the old counters into the new ledger. The worker then brings every product across. */
  async start(companyId: string, actor: string): Promise<void> {
    const now = await this.status(companyId);
    if (now.mode === 'ledger') throw new StockError('The new ledger is already the truth for this company.', 'ALREADY_ON');
    if (now.mode === 'shadow') throw new StockError('The shadow is already running.', 'ALREADY_STARTED');
    await this.shadow.setShadow(companyId, true);
    await this.decisionLog.record({ companyId, subject: { type: 'stock_ledger', id: companyId }, action: 'stock.ledger.shadow_started', actor: { type: 'user', id: actor }, from: 'off', to: 'shadow' });
  }

  /** Compares the new ledger with the old counters, keeps the result, and says whether they agree. */
  async check(companyId: string, trigger: 'manual' | 'nightly' | 'cutover', actor: string | null): Promise<{ ok: boolean; report: ShadowReport }> {
    const report = await this.shadow.compare({ holds: true, journal: true });
    const ok = differences(report) === 0;
    await this.db.insert(stockIntegrityRuns).values({ companyId, trigger, ok, report: report as unknown as Record<string, unknown>, ranBy: actor });
    return { ok, report };
  }

  /**
   * The switch. Everything happens in one transaction: changes to products wait, the old reservations become holds, the two sides are
   * compared, and only if they agree does the company start keeping stock in the new ledger. Best done at a quiet hour: sales that
   * touch stock wait for the few seconds it takes.
   */
  async switchToLedger(companyId: string, actor: string): Promise<{ converted: number; products: number }> {
    const before = await this.status(companyId);
    if (before.mode === 'ledger') throw new StockError('The new ledger is already the truth for this company.', 'ALREADY_ON');
    if (before.mode !== 'shadow') throw new StockError('Start the shadow first, and let it bring all the stock across.', 'SHADOW_NOT_STARTED');
    if (!before.backfillDone) throw new StockError('The shadow is still bringing stock across. Wait until it has finished.', 'SHADOW_NOT_DONE');
    const place = await this.locations.ensureDefault(companyId);
    // A refusal inside the transaction undoes everything it did (the holds it made too), so the check that found the difference is
    // written down afterwards, outside it.
    let refused: ShadowReport | null = null;
    let result: { converted: number; products: number } | null = null;
    try {
      result = await this.db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE`);
        await tx.execute(sql`LOCK TABLE inventory_movements IN SHARE ROW EXCLUSIVE MODE`);
        const converted = await this.shadow.convertLegacyHolds(tx, companyId, place.id);
        const report = await this.shadow.compare({ holds: true, journal: true, executor: tx });
        if (differences(report) > 0) throw new Refused(report);
        await tx.insert(stockIntegrityRuns).values({ companyId, trigger: 'cutover', ok: true, report: report as unknown as Record<string, unknown>, ranBy: actor });
        await tx.update(stockSettings).set({ ledgerMode: true, shadowWrite: false, updatedAt: sql`now()` }).where(eq(stockSettings.companyId, companyId));
        await this.decisionLog.record({ companyId, subject: { type: 'stock_ledger', id: companyId }, action: 'stock.ledger.switched_on', actor: { type: 'user', id: actor }, from: 'shadow', to: 'ledger', outcome: { convertedHolds: converted, products: report.products } }, tx);
        return { converted, products: report.products };
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      refused = error.report;
    }
    if (refused !== null) {
      await this.db.insert(stockIntegrityRuns).values({ companyId, trigger: 'cutover', ok: false, report: refused as unknown as Record<string, unknown>, ranBy: actor });
      const n = differences(refused);
      throw new StockError(`The new ledger and the old counters still differ (${String(n)} item${n === 1 ? '' : 's'}), so nothing was switched. Look at the check and put the differences right first.`, 'SHADOW_DIFFERS');
    }
    if (result === null) throw new StockError('The switch did not finish.', 'NOT_SAVED');
    return result;
  }

  /**
   * Back to keeping stock the old way. The per-location figures stop being kept (they are left as they were), and the old counters,
   * which followed the ledger all along, carry on. Refused while the ledger still holds promises or stock on its way: the old way
   * could not settle them.
   */
  async rollback(companyId: string, actor: string, reason: string): Promise<void> {
    const why = reason.trim();
    if (why === '') throw new StockError('Say why you are going back to the old way.', 'REASON_NEEDED');
    if (why.length > 300) throw new StockError('Keep the reason to 300 characters.', 'REASON_TOO_LONG');
    const now = await this.status(companyId);
    if (now.mode !== 'ledger') throw new StockError('The company is not keeping stock in the new ledger.', 'NOT_ON');
    if (now.open.holds > 0 || now.open.transfersOnTheWay > 0) {
      const parts = [
        now.open.holds > 0 ? `${String(now.open.holds)} stock hold${now.open.holds === 1 ? '' : 's'} for orders` : null,
        now.open.transfersOnTheWay > 0 ? `${String(now.open.transfersOnTheWay)} transfer${now.open.transfersOnTheWay === 1 ? '' : 's'} on the way` : null,
      ].filter((x): x is string => x !== null);
      throw new StockError(`The old way cannot settle ${parts.join(' and ')}. Let them finish (or cancel the orders) and try again.`, 'OPEN_WORK');
    }
    await this.db.transaction(async (tx) => {
      await tx.update(stockSettings).set({ ledgerMode: false, updatedAt: sql`now()` }).where(eq(stockSettings.companyId, companyId));
      await this.decisionLog.record({ companyId, subject: { type: 'stock_ledger', id: companyId }, action: 'stock.ledger.switched_off', actor: { type: 'user', id: actor }, from: 'ledger', to: 'off', reason: { text: why } }, tx);
    });
  }
}
