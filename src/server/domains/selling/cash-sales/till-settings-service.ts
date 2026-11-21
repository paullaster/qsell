import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { cashSaleSettings } from '@/server/db/drizzle/schema';
import { parseTillMode, TILL_DEFAULT, type TillMode } from './till-rules';

export class TillSettingsError extends Error {}

/** How the counter looks for this company: inside the admin page (the default) or as a full-screen till. A preference, not a control. */
export class TillSettingsService {
  constructor(private readonly db: DrizzleDb) {}

  async get(companyId: string): Promise<{ tillMode: TillMode; updatedBy: string | null; updatedAt: string | null }> {
    const [row] = await this.db.select().from(cashSaleSettings).where(eq(cashSaleSettings.companyId, companyId)).limit(1);
    if (row === undefined) return { tillMode: TILL_DEFAULT, updatedBy: null, updatedAt: null };
    return { tillMode: parseTillMode(row.tillMode) ?? TILL_DEFAULT, updatedBy: row.updatedBy === '' ? null : row.updatedBy, updatedAt: row.updatedAt.toISOString() };
  }

  async save(companyId: string, userId: string, raw: unknown): Promise<{ tillMode: TillMode }> {
    const tillMode = parseTillMode(raw);
    if (tillMode === null) throw new TillSettingsError('Choose how the counter looks: inside the admin page, or as a full-screen till.');
    await this.db
      .insert(cashSaleSettings)
      .values({ companyId, tillMode, updatedBy: userId })
      .onConflictDoUpdate({ target: cashSaleSettings.companyId, set: { tillMode, updatedBy: userId, updatedAt: new Date() } });
    return { tillMode };
  }
}
