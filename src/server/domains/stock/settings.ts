import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { stockSettings } from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { StockError } from './errors';
import type { StockShadow } from './shadow';

/** A database handle or an open transaction: all the writer needs. */
export type Queryable = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/** Whether the ledger is the truth, read inside a transaction already open (a second connection could starve the pool). */
export async function isLedgerModeIn(tx: Queryable): Promise<boolean> {
  const rows = [...(await tx.execute<{ ledger_mode: boolean }>(sql`SELECT ledger_mode FROM stock_settings WHERE company_id = stock_current_company()`))];
  return rows[0]?.ledger_mode === true;
}

export interface StockMode {
  shadowWrite: boolean;
  ledgerMode: boolean;
  unpaidHoldMinutes: number;
}

const MAX_HOLD_MINUTES = 7 * 24 * 60;

/**
 * Which way stock is kept: the old counters alone, the old counters with the new ledger mirroring them (shadow), or the ledger as the
 * truth with the counters following it. Read on every reservation, so it is one indexed row and nothing is cached.
 */
export class StockSettingsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly company: CompanySettingsRepository,
  ) {}

  async get(): Promise<StockMode> {
    const { id } = await this.company.ensureSeeded();
    const [row] = await this.db.select().from(stockSettings).where(eq(stockSettings.companyId, id)).limit(1);
    return { shadowWrite: row?.shadowWrite ?? false, ledgerMode: row?.ledgerMode ?? false, unpaidHoldMinutes: row?.unpaidHoldMinutes ?? 0 };
  }

  async isLedgerMode(): Promise<boolean> {
    return (await this.get()).ledgerMode;
  }

  /**
   * Makes the ledger the truth (design §10, the cut-over). Turning it on is refused unless the shadow has brought every product across
   * and the comparison finds nothing different, so it cannot be switched on over a ledger that does not match the shelves. It ends the
   * shadow, since from then on the counters follow the balances. Nothing exposes this to a person yet; `requireCleanShadow: false` is
   * for tests and for a fresh install with no stock to bring across.
   */
  async setLedgerMode(companyId: string, on: boolean, options: { requireCleanShadow?: boolean; shadow?: StockShadow } = {}): Promise<void> {
    await this.db.insert(stockSettings).values({ companyId }).onConflictDoNothing();
    if (on && options.requireCleanShadow !== false) {
      const shadow = options.shadow;
      if (shadow === undefined) throw new StockError('The shadow check is needed to switch the ledger on.', 'NEEDS_SHADOW');
      const status = await shadow.status(companyId);
      if (!status.shadowWrite || status.backfillDoneAt === null) {
        throw new StockError('Switch the shadow on and let it bring all stock across before the ledger becomes the truth.', 'SHADOW_NOT_DONE');
      }
      const r = await shadow.compare();
      const different = r.onHandDiffers + r.reservedDiffers + r.ledgerDiffers + r.negative + r.reservationsDiffer + r.journalDiffers;
      if (different > 0) throw new StockError(`The ledger and the stock counters still differ for ${String(different)} item(s). Look at the comparison before switching over.`, 'SHADOW_DIFFERS');
    }
    await this.db
      .update(stockSettings)
      .set(on ? { ledgerMode: true, shadowWrite: false, updatedAt: sql`now()` } : { ledgerMode: false, updatedAt: sql`now()` })
      .where(eq(stockSettings.companyId, companyId));
  }

  /** How long an unpaid shop order holds stock; 0 holds it until the order is settled or released. */
  async setUnpaidHoldMinutes(companyId: string, minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_HOLD_MINUTES) throw new StockError('Choose a whole number of minutes from 0 to 10080 (7 days). 0 keeps the hold until the order is settled.', 'BAD_HOLD');
    await this.db.insert(stockSettings).values({ companyId }).onConflictDoNothing();
    await this.db.update(stockSettings).set({ unpaidHoldMinutes: minutes, updatedAt: sql`now()` }).where(eq(stockSettings.companyId, companyId));
  }
}
