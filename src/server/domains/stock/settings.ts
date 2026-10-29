import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { stockSettings } from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { StockError } from './errors';

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
   * Makes the ledger the truth. For the cut-over only (design §10): receipts and adjustments must already go through the ledger, which
   * arrives with the stock documents, so nothing exposes this to a person yet. It ends the shadow, since the counters now follow the balances.
   */
  async setLedgerMode(companyId: string, on: boolean): Promise<void> {
    await this.db.insert(stockSettings).values({ companyId }).onConflictDoNothing();
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
