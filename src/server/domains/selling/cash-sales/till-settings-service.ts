import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { cashSaleSettings } from '@/server/db/drizzle/schema';
import { parseReceiptDiscount, parseTillMode, RECEIPT_DISCOUNT_DEFAULT, TILL_DEFAULT, type ReceiptDiscount, type TillMode } from './till-rules';

export class TillSettingsError extends Error {}

export interface TillSettings {
  tillMode: TillMode;
  receiptDiscount: ReceiptDiscount;
  updatedBy: string | null;
  updatedAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** How the counter looks for this company (inside the admin page, the default, or a full-screen till) and what its receipts say about discounts. Preferences, not controls. */
export class TillSettingsService {
  constructor(private readonly db: DrizzleDb) {}

  async get(companyId: string): Promise<TillSettings> {
    const [row] = await this.db.select().from(cashSaleSettings).where(eq(cashSaleSettings.companyId, companyId)).limit(1);
    if (row === undefined) return { tillMode: TILL_DEFAULT, receiptDiscount: RECEIPT_DISCOUNT_DEFAULT, updatedBy: null, updatedAt: null };
    return { tillMode: parseTillMode(row.tillMode) ?? TILL_DEFAULT, receiptDiscount: parseReceiptDiscount(row.receiptDiscount) ?? RECEIPT_DISCOUNT_DEFAULT, updatedBy: row.updatedBy === '' ? null : row.updatedBy, updatedAt: row.updatedAt.toISOString() };
  }

  /** Saves what was sent; a choice that is left out stays as it was, and one that is not a real choice is refused. */
  async save(companyId: string, userId: string, raw: unknown): Promise<{ tillMode: TillMode; receiptDiscount: ReceiptDiscount }> {
    const sent = isRecord(raw) ? raw : {};
    const now = await this.get(companyId);
    const tillMode = sent.tillMode === undefined ? now.tillMode : parseTillMode(sent.tillMode);
    if (tillMode === null) throw new TillSettingsError('Choose how the counter looks: inside the admin page, or as a full-screen till.');
    const receiptDiscount = sent.receiptDiscount === undefined ? now.receiptDiscount : parseReceiptDiscount(sent.receiptDiscount);
    if (receiptDiscount === null) throw new TillSettingsError('Choose what the receipt says about discounts: nothing, one total, or the discount on each item.');
    await this.db
      .insert(cashSaleSettings)
      .values({ companyId, tillMode, receiptDiscount, updatedBy: userId })
      .onConflictDoUpdate({ target: cashSaleSettings.companyId, set: { tillMode, receiptDiscount, updatedBy: userId, updatedAt: new Date() } });
    return { tillMode, receiptDiscount };
  }
}
