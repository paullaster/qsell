import { and, eq, sql } from 'drizzle-orm';
import { stockDocumentLines, stockDocuments, stockLocations, stockSettings, type StockDocumentLineRow, type StockDocumentRow } from '@/server/db/drizzle/schema';
import { COUNT_MODES, MAX_DOCUMENT_LINES, checkCountEntries, countNeedsApproval, countVariance, varianceValue, type CountMode } from '@/lib/stock-documents';
import { StockError } from './errors';
import { cleanReason, documentLines, journalChange, lockDocument, logStep, mustBe, nextNumber, productFacts, requireLedger, touch, unitProblem, type DocActor, type DocumentDeps, type Tx } from './documents';

const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;
/** A whole-location count lists every product with stock there; more than this should be counted in parts (cycle counts). */
export const MAX_FULL_COUNT_LINES = 5000;

export interface CountInput {
  locationId: string;
  mode: unknown;
  blind?: boolean;
  /** The products to count in a cycle count. */
  productIds?: unknown;
  note?: string;
}

export interface CountLineView {
  line: StockDocumentLineRow;
  productName: string;
  /** Hidden from the counter of a blind count until the count is handed in. */
  expected: number | null;
  /** Stock that moved after the snapshot, up to the moment the line was counted. */
  movedSince: number | null;
  variance: number | null;
}

export interface CountView {
  document: StockDocumentRow;
  lines: CountLineView[];
  varianceValue: number;
  needsApproval: boolean;
}

/**
 * Counting the stock at one location without stopping the shop. A count remembers where the ledger stood when it was opened; the
 * difference it posts is what was found less what should have been there at the moment of counting, so a sale made while counting is
 * not mistaken for a loss. A count whose differences are worth more than the company's limit needs a second person.
 * Design: docs/architecture/stock-locations.md §4.7.
 */
export class CountService {
  constructor(private readonly deps: DocumentDeps) {}

  private async threshold(tx: Tx, companyId: string): Promise<number> {
    const [s] = await tx.select({ v: stockSettings.countApprovalValue }).from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
    return Number(s?.v ?? 0);
  }

  /** What the ledger said was at the location for a product when the count opened, for many products at once. */
  private async expectedAt(tx: Tx, locationId: string, snapshot: number, productIds: readonly string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = [...(await tx.execute<{ product_id: string; total: string }>(sql`
      SELECT product_id, COALESCE(sum(quantity), 0) AS total FROM stock_movements
      WHERE location_id = ${locationId}::uuid AND id <= ${snapshot} AND product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY product_id`))];
    return new Map(rows.map((r) => [r.product_id, Number(r.total)]));
  }

  private async movedSince(tx: Tx, locationId: string, snapshot: number, productId: string, until: Date): Promise<number> {
    const rows = [...(await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(sum(quantity), 0) AS total FROM stock_movements
      WHERE location_id = ${locationId}::uuid AND product_id = ${productId} AND id > ${snapshot} AND recorded_at <= ${until.toISOString()}::timestamptz`))];
    return Number(rows[0]?.total ?? 0);
  }

  async open(companyId: string, actor: DocActor, input: CountInput): Promise<{ id: string; number: string; lines: number }> {
    if (!(COUNT_MODES as readonly unknown[]).includes(input.mode)) throw new StockError('Choose a full count or a cycle count.', 'BAD_MODE');
    const mode = input.mode as CountMode;
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 500) throw new StockError('Keep the note to 500 characters.', 'NOTE_TOO_LONG');
    return await this.deps.db.transaction(async (tx) => {
      await requireLedger(tx);
      const [loc] = await tx.select().from(stockLocations).where(and(eq(stockLocations.id, input.locationId), eq(stockLocations.companyId, companyId))).limit(1);
      if (loc === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
      if (!loc.isActive || loc.kind === 'transit') throw new StockError(`${loc.name} cannot be counted.`, 'INACTIVE');
      const snapshot = Number([...(await tx.execute<{ id: string }>(sql`SELECT COALESCE(max(id), 0) AS id FROM stock_movements`))][0]?.id ?? 0);

      let productIds: string[];
      if (mode === 'full') {
        const rows = [...(await tx.execute<{ product_id: string }>(sql`
          SELECT m.product_id FROM stock_movements m JOIN products p ON p.id = m.product_id AND p.deleted_at IS NULL
          WHERE m.location_id = ${loc.id}::uuid AND m.id <= ${snapshot} GROUP BY m.product_id HAVING sum(m.quantity) <> 0 ORDER BY m.product_id`))];
        productIds = rows.map((r) => r.product_id);
        if (productIds.length > MAX_FULL_COUNT_LINES) throw new StockError(`${loc.name} holds ${String(productIds.length)} products, more than one full count can list (${String(MAX_FULL_COUNT_LINES)}). Count it in parts, with cycle counts.`, 'TOO_MANY');
      } else {
        const ids: unknown = input.productIds;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x): x is string => typeof x === 'string' && x !== '')) throw new StockError('Choose the products to count.', 'NO_PRODUCTS');
        if (ids.length > MAX_DOCUMENT_LINES) throw new StockError(`A cycle count can list at most ${String(MAX_DOCUMENT_LINES)} products.`, 'TOO_MANY');
        productIds = [...new Set(ids)].sort();
        const facts = await productFacts(tx, productIds);
        if (productIds.some((id) => facts.get(id)?.deleted !== false)) throw new StockError('A product to count could not be found.', 'NO_PRODUCT');
      }
      const id = crypto.randomUUID();
      const number = await nextNumber(this.deps, tx, 'stock_count', companyId, id);
      await tx.insert(stockDocuments).values({ id, companyId, number, kind: 'count', state: 'counting', fromLocationId: loc.id, countMode: mode, blind: input.blind === true, snapshotMovementId: snapshot, note, createdBy: actor.id });
      const expected = await this.expectedAt(tx, loc.id, snapshot, productIds);
      for (let i = 0; i < productIds.length; i += 500) {
        await tx.insert(stockDocumentLines).values(productIds.slice(i, i + 500).map((productId, j) => ({ documentId: id, lineNo: i + j + 1, productId, expectedQuantity: round(expected.get(productId) ?? 0) })));
      }
      await logStep(this.deps, tx, { id, companyId, kind: 'count' }, 'opened', actor, null, 'counting', { outcome: { number, location: loc.code, mode, blind: input.blind === true, lines: productIds.length, snapshot } });
      return { id, number, lines: productIds.length };
    });
  }

  /** Writes down what was counted, each with who counted it and when. A product not on the list is added to it. */
  async record(companyId: string, actor: DocActor, id: string, entries: unknown): Promise<{ counted: number }> {
    const checked = checkCountEntries(entries);
    if (!checked.ok) throw new StockError(checked.error, 'BAD_LINES');
    return await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counting'], 'counted into');
      const lines = await documentLines(tx, id);
      const facts = await productFacts(tx, checked.lines.map((l) => l.productId));
      const unlisted = checked.lines.filter((l) => !lines.some((x) => x.productId === l.productId));
      const expectedNew = await this.expectedAt(tx, doc.fromLocationId ?? '', doc.snapshotMovementId ?? 0, unlisted.map((l) => l.productId));
      let next = lines.reduce((m, l) => Math.max(m, l.lineNo), 0);
      if (lines.length + unlisted.length > MAX_FULL_COUNT_LINES) throw new StockError('This count is full.', 'TOO_MANY');
      for (const e of checked.lines) {
        const f = facts.get(e.productId);
        if (f === undefined || f.deleted) throw new StockError('A counted product could not be found.', 'NO_PRODUCT');
        const problem = unitProblem(f, e.quantity, 'The counted quantity');
        if (problem !== null) throw new StockError(problem, 'BAD_QUANTITY');
        const existing = lines.find((l) => l.productId === e.productId);
        if (existing === undefined) {
          next += 1;
          await tx.insert(stockDocumentLines).values({ documentId: id, lineNo: next, productId: e.productId, expectedQuantity: round(expectedNew.get(e.productId) ?? 0), countedQuantity: e.quantity, countedBy: actor.id, countedAt: sql`now()` });
        } else {
          await tx.update(stockDocumentLines).set({ countedQuantity: e.quantity, countedBy: actor.id, countedAt: sql`now()` }).where(eq(stockDocumentLines.id, existing.id));
        }
      }
      await touch(tx, id, {});
      return { counted: checked.lines.length };
    });
  }

  /** The counter hands the count in: no more figures, and the differences can now be seen. */
  async submit(companyId: string, actor: DocActor, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counting'], 'handed in');
      const lines = await documentLines(tx, id);
      if (!lines.some((l) => l.countedQuantity !== null)) throw new StockError('Count at least one product before handing the count in.', 'NOTHING_COUNTED');
      await touch(tx, id, { state: 'counted' });
      await logStep(this.deps, tx, doc, 'handed_in', actor, 'counting', 'counted', { outcome: { counted: lines.filter((l) => l.countedQuantity !== null).length } });
    });
  }

  /** Back to counting, to correct figures, before it is posted. */
  async reopen(companyId: string, actor: DocActor, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counted'], 'reopened');
      await touch(tx, id, { state: 'counting' });
      await logStep(this.deps, tx, doc, 'reopened', actor, 'counted', 'counting');
    });
  }

  private async work(tx: Tx, doc: StockDocumentRow, lines: StockDocumentLineRow[]) {
    const facts = await productFacts(tx, lines.map((l) => l.productId));
    const out: { line: StockDocumentLineRow; productName: string; cost: number; movedSince: number | null; variance: number | null }[] = [];
    for (const l of lines) {
      const f = facts.get(l.productId);
      if (l.countedQuantity === null || l.countedAt === null) {
        out.push({ line: l, productName: f?.name ?? l.productId, cost: f?.cost ?? 0, movedSince: null, variance: null });
        continue;
      }
      const moved = await this.movedSince(tx, doc.fromLocationId ?? '', doc.snapshotMovementId ?? 0, l.productId, l.countedAt);
      out.push({ line: l, productName: f?.name ?? l.productId, cost: f?.cost ?? 0, movedSince: round(moved), variance: countVariance(l.expectedQuantity ?? 0, moved, l.countedQuantity) });
    }
    return out;
  }

  /** The count with its differences. A blind count shows its counter no expected figures until it is handed in. */
  async get(companyId: string, id: string, options: { asCounter?: boolean } = {}): Promise<CountView> {
    return await this.deps.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(stockDocuments).where(and(eq(stockDocuments.id, id), eq(stockDocuments.companyId, companyId), eq(stockDocuments.kind, 'count'))).limit(1);
      if (doc === undefined) throw new StockError('That count could not be found.', 'NOT_FOUND');
      const lines = await documentLines(tx, id);
      const limit = await this.threshold(tx, companyId);
      const worked = doc.state === 'posted' ? lines.map((l) => ({ line: l, productName: l.productId, cost: Number(l.unitCost), movedSince: null, variance: l.varianceQuantity })) : await this.work(tx, doc, lines);
      const names = await productFacts(tx, lines.map((l) => l.productId));
      const hide = doc.blind && doc.state === 'counting' && options.asCounter !== false;
      const value = varianceValue(worked.filter((w) => w.variance !== null).map((w) => ({ variance: w.variance ?? 0, unitCost: w.cost })));
      return {
        document: doc,
        lines: worked.map((w) => ({ line: w.line, productName: names.get(w.line.productId)?.name ?? w.productName, expected: hide ? null : w.line.expectedQuantity, movedSince: hide ? null : w.movedSince, variance: hide ? null : w.variance })),
        varianceValue: value,
        needsApproval: countNeedsApproval(value, limit),
      };
    });
  }

  /** A second person agrees to the differences. Whoever counted cannot be that person. */
  async approve(companyId: string, actor: DocActor, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counted'], 'approved');
      const lines = await documentLines(tx, id);
      if (doc.createdBy === actor.id || lines.some((l) => l.countedBy === actor.id)) throw new StockError('Someone who did not take part in the count must approve it.', 'SAME_PERSON');
      await touch(tx, id, { state: 'approved', approvedBy: actor.id, approvedAt: sql`now()` });
      await logStep(this.deps, tx, doc, 'approved', actor, 'counted', 'approved');
    });
  }

  /** Makes the differences real: one count_variance movement per product that differs, and the matching journal line. */
  async post(companyId: string, actor: DocActor, id: string): Promise<{ adjusted: number }> {
    return await this.deps.db.transaction(async (tx) => {
      await requireLedger(tx);
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counted', 'approved'], 'posted');
      const lines = await documentLines(tx, id);
      const worked = await this.work(tx, doc, lines);
      const counted = worked.filter((w) => w.variance !== null);
      const value = varianceValue(counted.map((w) => ({ variance: w.variance ?? 0, unitCost: w.cost })));
      if (doc.state === 'counted' && countNeedsApproval(value, await this.threshold(tx, companyId))) {
        throw new StockError(`The differences are worth ${value.toFixed(2)}, more than can be posted without a second person agreeing.`, 'NEEDS_APPROVAL');
      }
      let adjusted = 0;
      for (const w of [...counted].sort((a, b) => a.line.productId.localeCompare(b.line.productId))) {
        const variance = w.variance ?? 0;
        if (variance !== 0) {
          await this.deps.ledger.post(tx, {
            companyId,
            productId: w.line.productId,
            locationId: doc.fromLocationId ?? '',
            type: 'count_variance',
            quantity: variance,
            unitCost: w.cost,
            documentType: 'stock_count',
            documentId: doc.id,
            documentLineId: `${w.line.id}:count`,
            reasonCode: 'stock_count',
            actor: { type: 'user', id: actor.id },
            note: `Count ${doc.number}: counted ${String(w.line.countedQuantity)}, expected ${String(round((w.line.expectedQuantity ?? 0) + (w.movedSince ?? 0)))}`,
          });
          await journalChange(tx, { productId: w.line.productId, delta: variance, changeType: 'physical_audit', referenceId: doc.number, actor: actor.id, note: `Count ${doc.number}` });
          adjusted += 1;
        }
        await tx.update(stockDocumentLines).set({ varianceQuantity: variance, unitCost: String(w.cost) }).where(eq(stockDocumentLines.id, w.line.id));
      }
      await touch(tx, id, { state: 'posted', postedBy: actor.id, postedAt: sql`now()` });
      await logStep(this.deps, tx, doc, 'posted', actor, doc.state, 'posted', { outcome: { counted: counted.length, adjusted, value } });
      return { adjusted };
    });
  }

  async cancel(companyId: string, actor: DocActor, id: string, reason: unknown): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'count');
      mustBe(doc, ['counting', 'counted', 'approved'], 'cancelled');
      const why = cleanReason(reason, 'the count is being cancelled');
      await touch(tx, id, { state: 'cancelled', cancelledBy: actor.id, cancelledAt: sql`now()`, cancelReason: why });
      await logStep(this.deps, tx, doc, 'cancelled', actor, doc.state, 'cancelled', { reason: why });
    });
  }
}
