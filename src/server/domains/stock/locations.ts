import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, stockBalances, stockLocations, type StockLocationRow } from '@/server/db/drizzle/schema';
import { checkLocation, type LocationInput } from '@/lib/stock';
import { StockError } from './errors';

/** A unique-key violation, however deep the driver wrapped it. */
const isDuplicate = (error: unknown): boolean => {
  for (let e: unknown = error, depth = 0; typeof e === 'object' && e !== null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
};

/**
 * The places stock can be held. Every company has one default location ("Main stock"); a company with only that one sees no change.
 * A location that holds stock is never deleted or deactivated: it is emptied or transferred first.
 */
export class StockLocationService {
  constructor(private readonly db: DrizzleDb) {}

  /** The company's default location, made if it has none. */
  async ensureDefault(companyId: string): Promise<StockLocationRow> {
    const [existing] = await this.db.select().from(stockLocations).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.isDefault, true))).limit(1);
    if (existing !== undefined) return existing;
    const [made] = await this.db
      .insert(stockLocations)
      .values({ companyId, code: 'MAIN', name: 'Main stock', kind: 'warehouse', isDefault: true })
      .onConflictDoNothing()
      .returning();
    if (made !== undefined) return made;
    const [again] = await this.db.select().from(stockLocations).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.isDefault, true))).limit(1);
    if (again === undefined) throw new StockError('The main stock location could not be made. Another location already uses the code MAIN.', 'NO_DEFAULT');
    return again;
  }

  async list(companyId: string, includeInactive = false): Promise<StockLocationRow[]> {
    return await this.db
      .select()
      .from(stockLocations)
      .where(includeInactive ? eq(stockLocations.companyId, companyId) : and(eq(stockLocations.companyId, companyId), eq(stockLocations.isActive, true)))
      .orderBy(asc(stockLocations.code));
  }

  async get(companyId: string, id: string): Promise<StockLocationRow> {
    const [row] = await this.db.select().from(stockLocations).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.id, id))).limit(1);
    if (row === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
    return row;
  }

  private async branchOk(companyId: string, branchId: string | null): Promise<void> {
    if (branchId === null) return;
    const [b] = await this.db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, companyId))).limit(1);
    if (b === undefined) throw new StockError('That branch could not be found.', 'BAD_BRANCH');
  }

  async create(companyId: string, input: LocationInput): Promise<StockLocationRow> {
    const checked = checkLocation(input);
    if (!checked.ok) throw new StockError(checked.error, 'BAD_LOCATION');
    await this.branchOk(companyId, checked.location.branchId);
    try {
      const [row] = await this.db.insert(stockLocations).values({ companyId, ...checked.location }).returning();
      if (row === undefined) throw new StockError('The location could not be saved.', 'NOT_SAVED');
      return row;
    } catch (error) {
      if (isDuplicate(error)) throw new StockError(`A location with the code ${checked.location.code} already exists.`, 'DUPLICATE_CODE');
      throw error;
    }
  }

  async update(companyId: string, id: string, input: LocationInput): Promise<StockLocationRow> {
    const current = await this.get(companyId, id);
    const checked = checkLocation(input);
    if (!checked.ok) throw new StockError(checked.error, 'BAD_LOCATION');
    await this.branchOk(companyId, checked.location.branchId);
    try {
      const [row] = await this.db
        .update(stockLocations)
        .set({ ...checked.location, updatedAt: sql`now()` })
        .where(and(eq(stockLocations.id, current.id), eq(stockLocations.companyId, companyId)))
        .returning();
      if (row === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
      return row;
    } catch (error) {
      if (isDuplicate(error)) throw new StockError(`A location with the code ${checked.location.code} already exists.`, 'DUPLICATE_CODE');
      throw error;
    }
  }

  /** Makes this the company's default location, and the old default an ordinary one, in one step. */
  async makeDefault(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [target] = await tx.select().from(stockLocations).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.id, id))).for('update').limit(1);
      if (target === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
      if (!target.isActive) throw new StockError('An inactive location cannot be the default.', 'INACTIVE');
      await tx.update(stockLocations).set({ isDefault: false, updatedAt: sql`now()` }).where(and(eq(stockLocations.companyId, companyId), ne(stockLocations.id, id), eq(stockLocations.isDefault, true)));
      await tx.update(stockLocations).set({ isDefault: true, updatedAt: sql`now()` }).where(eq(stockLocations.id, id));
    });
  }

  /** Stops a location being used. Refused for the default location and for one that still holds or has promised stock. */
  async deactivate(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [target] = await tx.select().from(stockLocations).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.id, id))).for('update').limit(1);
      if (target === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
      if (target.isDefault) throw new StockError('The default location cannot be stopped. Make another location the default first.', 'IS_DEFAULT');
      const [held] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockBalances)
        .where(and(eq(stockBalances.locationId, id), sql`(${stockBalances.onHand} <> 0 OR ${stockBalances.reserved} <> 0)`));
      if ((held?.n ?? 0) > 0) throw new StockError(`This location still holds or has promised stock of ${String(held?.n ?? 0)} product(s). Move or sell it first.`, 'HAS_STOCK');
      await tx.update(stockLocations).set({ isActive: false, updatedAt: sql`now()` }).where(eq(stockLocations.id, id));
    });
  }

  async reactivate(companyId: string, id: string): Promise<void> {
    const changed = await this.db.update(stockLocations).set({ isActive: true, updatedAt: sql`now()` }).where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.id, id))).returning({ id: stockLocations.id });
    if (changed.length === 0) throw new StockError('That location could not be found.', 'NOT_FOUND');
  }
}
