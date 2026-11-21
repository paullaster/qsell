import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { heldSales, products } from '@/server/db/drizzle/schema';
import type { SalesOrderLineInput } from '../domain/sales-order-input';
import { parseCashSaleLines } from './cash-sale-input';
import type { ShiftService } from '../shifts/shift-service';

export class HeldSaleError extends Error {}

/** The most sales one person may have set aside at once in a shift. */
export const MAX_HELD = 10;

export interface HeldSaleRow {
  id: string;
  label: string;
  lineCount: number;
  at: string;
  /** The first few things in it, for telling one from another. */
  preview: string[];
}

export interface RecalledSale {
  customerId: string | null;
  lines: (SalesOrderLineInput & { name: string })[];
}

interface Stored {
  customerId: string | null;
  lines: SalesOrderLineInput[];
}

/**
 * Sales set aside at the counter while the next customer is served. A held sale is only a draft of ids and counts: nothing is priced,
 * held in stock or paid until it is completed, and it is priced afresh when it is brought back. Kept with the shift and the person.
 */
export class HeldSaleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shifts: ShiftService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async mine(userId: string): Promise<string> {
    const shiftId = await this.shifts.openShiftOf(userId);
    if (shiftId === null) throw new HeldSaleError('You have no shift open, so there is nothing to put aside or bring back.');
    return shiftId;
  }

  async hold(companyId: string, userId: string, input: { label: unknown; sale: unknown }): Promise<HeldSaleRow> {
    const shiftId = await this.mine(userId);
    const read = parseCashSaleLines(input.sale);
    if (!read.ok) throw new HeldSaleError(read.error);
    if (read.lines.length === 0) throw new HeldSaleError('There is nothing in the sale to put aside.');
    const typed = typeof input.label === 'string' ? input.label.trim().slice(0, 60) : '';
    const stored: Stored = { customerId: read.customerId, lines: read.lines };
    const created = await this.db.transaction(async (tx) => {
      const [count] = await tx.select({ n: sql<string>`COUNT(*)::text` }).from(heldSales).where(and(eq(heldSales.shiftId, shiftId), eq(heldSales.userId, userId), eq(heldSales.status, 'held')));
      if (Number(count?.n ?? 0) >= MAX_HELD) throw new HeldSaleError(`You already have ${String(MAX_HELD)} sales on hold. Bring one back or give one up first.`);
      const [all] = await tx.select({ n: sql<string>`COUNT(*)::text` }).from(heldSales).where(and(eq(heldSales.shiftId, shiftId), eq(heldSales.userId, userId)));
      const label = typed === '' ? `Sale ${String(Number(all?.n ?? 0) + 1)}` : typed;
      const [row] = await tx.insert(heldSales).values({ companyId, shiftId, userId, label, payload: stored, lineCount: read.lines.length }).returning();
      if (row === undefined) throw new HeldSaleError('The sale could not be put aside. Please try again.');
      return row;
    });
    return { id: created.id, label: created.label, lineCount: created.lineCount, at: created.createdAt.toISOString(), preview: [] };
  }

  async list(companyId: string, userId: string): Promise<HeldSaleRow[]> {
    const shiftId = await this.shifts.openShiftOf(userId);
    if (shiftId === null) return [];
    const rows = await this.db.select().from(heldSales).where(and(eq(heldSales.companyId, companyId), eq(heldSales.shiftId, shiftId), eq(heldSales.userId, userId), eq(heldSales.status, 'held'))).orderBy(asc(heldSales.createdAt));
    const ids = [...new Set(rows.flatMap((r) => (r.payload as Stored).lines.slice(0, 3).map((l) => l.productId)))];
    const names = new Map<string, string>();
    if (ids.length > 0) for (const p of await this.db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, ids))) names.set(p.id, p.name);
    return rows.map((r) => ({ id: r.id, label: r.label, lineCount: r.lineCount, at: r.createdAt.toISOString(), preview: (r.payload as Stored).lines.slice(0, 3).map((l) => names.get(l.productId) ?? 'Item') }));
  }

  /** Brings a held sale back, once: it is marked recalled in the same step, so two tills or two taps never bring it back twice. */
  async recall(companyId: string, userId: string, id: string): Promise<RecalledSale> {
    const shiftId = await this.mine(userId);
    const row = await this.db.transaction(async (tx) => {
      const [found] = await tx.select().from(heldSales).where(and(eq(heldSales.id, id), eq(heldSales.companyId, companyId), eq(heldSales.shiftId, shiftId), eq(heldSales.userId, userId), eq(heldSales.status, 'held'))).limit(1).for('update');
      if (found === undefined) throw new HeldSaleError('That sale is no longer on hold.');
      await tx.update(heldSales).set({ status: 'recalled', resolvedAt: this.clock() }).where(eq(heldSales.id, id));
      return found;
    });
    const stored = row.payload as Stored;
    const names = new Map<string, string>();
    const ids = [...new Set(stored.lines.map((l) => l.productId))];
    if (ids.length > 0) for (const p of await this.db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, ids))) names.set(p.id, p.name);
    return { customerId: stored.customerId, lines: stored.lines.map((l) => ({ ...l, name: names.get(l.productId) ?? 'Item' })) };
  }

  async discard(companyId: string, userId: string, id: string): Promise<void> {
    const shiftId = await this.mine(userId);
    const done = await this.db.update(heldSales).set({ status: 'discarded', resolvedAt: this.clock() }).where(and(eq(heldSales.id, id), eq(heldSales.companyId, companyId), eq(heldSales.shiftId, shiftId), eq(heldSales.userId, userId), eq(heldSales.status, 'held'))).returning({ id: heldSales.id });
    if (done.length === 0) throw new HeldSaleError('That sale is no longer on hold.');
  }
}
