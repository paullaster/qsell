import { and, asc, eq, sql } from 'drizzle-orm';
import { stockBalances, stockDocumentLines, stockDocuments, stockLocations, stockSettings, type StockDocumentLineRow, type StockDocumentRow } from '@/server/db/drizzle/schema';
import { checkTransferLines, inTransit, stateAfterMovement } from '@/lib/stock-documents';
import { StockError } from './errors';
import { cleanReason, documentLines, journalChange, lockDocument, logStep, mustBe, nextNumber, productFacts, touch, unitProblem, type DocActor, type DocumentDeps, type Tx } from './documents';

const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;

export interface TransferInput {
  fromLocationId: string;
  toLocationId: string;
  note?: string;
  lines: unknown;
}

export interface TransferView {
  document: StockDocumentRow;
  lines: (StockDocumentLineRow & { productName: string; inTransit: number })[];
}

/**
 * Moving stock between two locations as one document: asked for, approved if the company wants it, shipped (the stock leaves the
 * sender into a transit location made for the transfer, so it is never nowhere), received in whole or in parts, and the part that
 * does not arrive is resolved as lost or sent back. Stock on hand over all locations never changes except by a loss. Every step is a
 * stamped, attributed line in the document's history. Design: docs/architecture/stock-locations.md §4.6.
 */
export class TransferService {
  constructor(private readonly deps: DocumentDeps) {}

  private async place(tx: Tx, companyId: string, id: string, role: string) {
    const [l] = await tx.select().from(stockLocations).where(and(eq(stockLocations.id, id), eq(stockLocations.companyId, companyId))).limit(1);
    if (l === undefined) throw new StockError(`The ${role} location could not be found.`, 'NOT_FOUND');
    if (!l.isActive) throw new StockError(`${l.name} is stopped, so it cannot be the ${role} of a transfer.`, 'INACTIVE');
    if (l.kind === 'transit') throw new StockError('A transit location belongs to a transfer already on its way and cannot be chosen.', 'IS_TRANSIT');
    return l;
  }

  private async checkedInput(tx: Tx, companyId: string, input: TransferInput) {
    if (input.fromLocationId === input.toLocationId) throw new StockError('Choose two different locations: a transfer moves stock from one place to another.', 'SAME_PLACE');
    const from = await this.place(tx, companyId, input.fromLocationId, 'sending');
    const to = await this.place(tx, companyId, input.toLocationId, 'receiving');
    const checked = checkTransferLines(input.lines);
    if (!checked.ok) throw new StockError(checked.error, 'BAD_LINES');
    const facts = await productFacts(tx, checked.lines.map((l) => l.productId));
    for (const l of checked.lines) {
      const f = facts.get(l.productId);
      if (f === undefined || f.deleted) throw new StockError('A product on this transfer could not be found.', 'NO_PRODUCT');
      const problem = unitProblem(f, l.quantity, 'The quantity');
      if (problem !== null) throw new StockError(problem, 'BAD_QUANTITY');
    }
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 500) throw new StockError('Keep the note to 500 characters.', 'NOTE_TOO_LONG');
    return { from, to, lines: checked.lines, note };
  }

  async create(companyId: string, actor: DocActor, input: TransferInput): Promise<{ id: string; number: string }> {
    return await this.deps.db.transaction(async (tx) => {
      const c = await this.checkedInput(tx, companyId, input);
      const id = crypto.randomUUID();
      const number = await nextNumber(this.deps, tx, 'stock_transfer', companyId, id);
      await tx.insert(stockDocuments).values({ id, companyId, number, kind: 'transfer', state: 'draft', fromLocationId: c.from.id, toLocationId: c.to.id, note: c.note, createdBy: actor.id });
      await tx.insert(stockDocumentLines).values(c.lines.map((l, i) => ({ documentId: id, lineNo: i + 1, productId: l.productId, quantity: l.quantity })));
      await logStep(this.deps, tx, { id, companyId, kind: 'transfer' }, 'created', actor, null, 'draft', { outcome: { number, from: c.from.code, to: c.to.code, lines: c.lines.length } });
      return { id, number };
    });
  }

  /** Changes a draft. The version the person saw must still be the current one, so two people cannot overwrite each other. */
  async updateDraft(companyId: string, actor: DocActor, id: string, expectedVersion: number, input: TransferInput): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['draft'], 'changed');
      if (doc.version !== expectedVersion) throw new StockError('Someone else changed this transfer. Open it again to see their changes.', 'CHANGED');
      const c = await this.checkedInput(tx, companyId, input);
      await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.documentId, id));
      await tx.insert(stockDocumentLines).values(c.lines.map((l, i) => ({ documentId: id, lineNo: i + 1, productId: l.productId, quantity: l.quantity })));
      await touch(tx, id, { fromLocationId: c.from.id, toLocationId: c.to.id, note: c.note });
      await logStep(this.deps, tx, doc, 'changed', actor, 'draft', 'draft', { outcome: { lines: c.lines.length } });
    });
  }

  async get(companyId: string, id: string): Promise<TransferView> {
    return await this.deps.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(stockDocuments).where(and(eq(stockDocuments.id, id), eq(stockDocuments.companyId, companyId), eq(stockDocuments.kind, 'transfer'))).limit(1);
      if (doc === undefined) throw new StockError('That transfer could not be found.', 'NOT_FOUND');
      const lines = await documentLines(tx, id);
      const facts = await productFacts(tx, lines.map((l) => l.productId));
      return { document: doc, lines: lines.map((l) => ({ ...l, productName: facts.get(l.productId)?.name ?? l.productId, inTransit: inTransit({ shipped: l.shippedQuantity, received: l.receivedQuantity, writtenOff: l.writtenOffQuantity, returned: l.returnedQuantity }) })) };
    });
  }

  async request(companyId: string, actor: DocActor, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['draft'], 'requested');
      await this.place(tx, companyId, doc.fromLocationId ?? '', 'sending');
      await this.place(tx, companyId, doc.toLocationId ?? '', 'receiving');
      await touch(tx, id, { state: 'requested', requestedBy: actor.id, requestedAt: sql`now()` });
      await logStep(this.deps, tx, doc, 'requested', actor, 'draft', 'requested');
    });
  }

  /** A second person agrees. Whoever asked for the transfer cannot approve it. */
  async approve(companyId: string, actor: DocActor, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['requested'], 'approved');
      if (doc.requestedBy === actor.id) throw new StockError('Someone other than the person who asked for this transfer must approve it.', 'SAME_PERSON');
      await touch(tx, id, { state: 'approved', approvedBy: actor.id, approvedAt: sql`now()` });
      await logStep(this.deps, tx, doc, 'approved', actor, 'requested', 'approved');
    });
  }

  async cancel(companyId: string, actor: DocActor, id: string, reason: unknown): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['draft', 'requested', 'approved'], 'cancelled');
      const why = cleanReason(reason, 'the transfer is being cancelled');
      await touch(tx, id, { state: 'cancelled', cancelledBy: actor.id, cancelledAt: sql`now()`, cancelReason: why });
      await logStep(this.deps, tx, doc, 'cancelled', actor, doc.state, 'cancelled', { reason: why });
    });
  }

  /**
   * The stock leaves the sender and arrives in a transit location made for this transfer, at the cost it carries. Stock already promised
   * to customers cannot be shipped. Ships what was asked for unless told to ship less.
   */
  async ship(companyId: string, actor: DocActor, id: string, shipLines?: { lineId: string; quantity: number }[]): Promise<{ transitLocationId: string }> {
    return await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['requested', 'approved'], 'shipped');
      const [settings] = await tx.select({ approval: stockSettings.transferRequiresApproval }).from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
      if (settings?.approval === true && doc.state !== 'approved') throw new StockError(`${doc.number} needs a second person to approve it before it can be shipped.`, 'NEEDS_APPROVAL');
      const from = await this.place(tx, companyId, doc.fromLocationId ?? '', 'sending');
      const to = await this.place(tx, companyId, doc.toLocationId ?? '', 'receiving');
      const lines = await documentLines(tx, id);
      const asked = new Map((shipLines ?? []).map((l) => [l.lineId, l.quantity]));
      for (const lineId of asked.keys()) if (!lines.some((l) => l.id === lineId)) throw new StockError('A line to ship is not on this transfer.', 'NO_LINE');
      const facts = await productFacts(tx, lines.map((l) => l.productId));
      const plan = lines.map((l) => {
        const q = round(asked.get(l.id) ?? l.quantity);
        if (!Number.isFinite(q) || q < 0 || q > l.quantity) throw new StockError(`You can ship from 0 up to ${String(l.quantity)} of "${facts.get(l.productId)?.name ?? l.productId}".`, 'BAD_QUANTITY');
        const f = facts.get(l.productId);
        const problem = f === undefined ? null : unitProblem(f, q, 'The quantity shipped');
        if (problem !== null) throw new StockError(problem, 'BAD_QUANTITY');
        return { line: l, quantity: q, cost: f?.cost ?? 0 };
      });
      if (!plan.some((p) => p.quantity > 0)) throw new StockError('Ship at least one product.', 'NOTHING_TO_SHIP');

      // What can leave is what is not promised to a customer.
      const free = await tx
        .select({ productId: stockBalances.productId, free: sql<number>`COALESCE(sum(${stockBalances.onHand} - ${stockBalances.reserved}), 0)::float8` })
        .from(stockBalances)
        .where(and(eq(stockBalances.locationId, from.id), sql`${stockBalances.productId} IN (${sql.join(plan.map((p) => sql`${p.line.productId}`), sql`, `)})`))
        .groupBy(stockBalances.productId);
      const freeBy = new Map(free.map((r) => [r.productId, r.free]));
      for (const p of plan) {
        const have = round(freeBy.get(p.line.productId) ?? 0);
        if (p.quantity > 0 && have < p.quantity) {
          throw new StockError(`${from.name} has ${String(have)} of "${facts.get(p.line.productId)?.name ?? p.line.productId}" that is not promised to a customer, and ${String(p.quantity)} are to be shipped.`, 'INSUFFICIENT');
        }
      }

      const [transit] = await tx
        .insert(stockLocations)
        .values({ companyId, code: `TRN-${doc.number}`.slice(0, 20), name: `In transit ${doc.number}`, kind: 'transit', isSellable: false, sellsChannels: [], fulfilsDelivery: false })
        .returning();
      if (transit === undefined) throw new StockError('The transit location could not be made.', 'NOT_SAVED');

      for (const p of [...plan].sort((a, b) => a.line.productId.localeCompare(b.line.productId))) {
        if (p.quantity <= 0) continue;
        const base = { companyId, productId: p.line.productId, unitCost: p.cost, documentType: 'stock_transfer', documentId: doc.id, actor: { type: 'user' as const, id: actor.id }, note: `Shipped on ${doc.number}` };
        await this.deps.ledger.post(tx, { ...base, locationId: from.id, type: 'transfer_out', quantity: -p.quantity, documentLineId: `${p.line.id}:ship` });
        await this.deps.ledger.post(tx, { ...base, locationId: transit.id, type: 'transfer_in', quantity: p.quantity, documentLineId: `${p.line.id}:ship` });
      }
      for (const p of plan) await tx.update(stockDocumentLines).set({ shippedQuantity: p.quantity, unitCost: String(p.cost) }).where(eq(stockDocumentLines.id, p.line.id));
      await touch(tx, id, { state: 'shipped', shippedBy: actor.id, shippedAt: sql`now()`, transitLocationId: transit.id });
      await logStep(this.deps, tx, doc, 'shipped', actor, doc.state, 'shipped', { outcome: { from: from.code, to: to.code, transit: transit.code, shipped: plan.filter((p) => p.quantity > 0).length } });
      return { transitLocationId: transit.id };
    });
  }

  /** Records what arrived, in whole or in part, moving it from the transit location into the receiving location. */
  async receive(companyId: string, actor: DocActor, id: string, entries: { lineId: string; quantity: number }[]): Promise<{ state: string }> {
    return await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['shipped', 'partly_received'], 'received');
      const to = await this.place(tx, companyId, doc.toLocationId ?? '', 'receiving');
      if (doc.transitLocationId === null) throw new StockError('This transfer has no transit stock.', 'NO_TRANSIT');
      if (!Array.isArray(entries) || entries.length === 0) throw new StockError('Say how much of what arrived.', 'NOTHING_TO_RECEIVE');
      const lines = await documentLines(tx, id);
      const facts = await productFacts(tx, lines.map((l) => l.productId));
      const step = doc.version;
      const done = new Set<string>();
      for (const e of [...entries].sort((a, b) => (lines.find((l) => l.id === a.lineId)?.productId ?? '').localeCompare(lines.find((l) => l.id === b.lineId)?.productId ?? ''))) {
        const line = lines.find((l) => l.id === e.lineId);
        if (line === undefined || done.has(e.lineId)) throw new StockError('A line to receive is not on this transfer, or is named twice.', 'NO_LINE');
        done.add(e.lineId);
        const q = round(e.quantity);
        const left = inTransit({ shipped: line.shippedQuantity, received: line.receivedQuantity, writtenOff: line.writtenOffQuantity, returned: line.returnedQuantity });
        const name = facts.get(line.productId)?.name ?? line.productId;
        if (!Number.isFinite(q) || q <= 0) throw new StockError(`Receive more than zero of "${name}".`, 'BAD_QUANTITY');
        if (q > left) throw new StockError(`Only ${String(left)} of "${name}" is still on its way, and ${String(q)} was entered.`, 'TOO_MUCH');
        const f = facts.get(line.productId);
        const problem = f === undefined ? null : unitProblem(f, q, 'The quantity received');
        if (problem !== null) throw new StockError(problem, 'BAD_QUANTITY');
        const base = { companyId, productId: line.productId, unitCost: Number(line.unitCost), documentType: 'stock_transfer', documentId: doc.id, documentLineId: `${line.id}:recv:${String(step)}`, actor: { type: 'user' as const, id: actor.id }, note: `Received on ${doc.number}` };
        await this.deps.ledger.post(tx, { ...base, locationId: doc.transitLocationId, type: 'transfer_out', quantity: -q });
        await this.deps.ledger.post(tx, { ...base, locationId: to.id, type: 'transfer_in', quantity: q });
        line.receivedQuantity = round(line.receivedQuantity + q);
        await tx.update(stockDocumentLines).set({ receivedQuantity: line.receivedQuantity }).where(eq(stockDocumentLines.id, line.id));
      }
      return { state: await this.settle(tx, doc, lines, actor, 'received') };
    });
  }

  /**
   * What did not arrive is lost (written off, with a reason) or sent back to the sender. Either way it leaves the transit location, and
   * once nothing is on its way the transfer is closed.
   */
  async resolve(companyId: string, actor: DocActor, id: string, entries: { lineId: string; quantity: number; action: 'write_off' | 'return_to_source' }[], reason: unknown): Promise<{ state: string }> {
    return await this.deps.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, companyId, id, 'transfer');
      mustBe(doc, ['shipped', 'partly_received'], 'settled');
      const why = cleanReason(reason, 'the stock did not arrive');
      if (doc.transitLocationId === null) throw new StockError('This transfer has no transit stock.', 'NO_TRANSIT');
      if (!Array.isArray(entries) || entries.length === 0) throw new StockError('Say what to do with the stock that did not arrive.', 'NOTHING_TO_RESOLVE');
      const lines = await documentLines(tx, id);
      const facts = await productFacts(tx, lines.map((l) => l.productId));
      const step = doc.version;
      const done = new Set<string>();
      for (const e of entries) {
        const line = lines.find((l) => l.id === e.lineId);
        if (line === undefined || done.has(e.lineId)) throw new StockError('A line to settle is not on this transfer, or is named twice.', 'NO_LINE');
        done.add(e.lineId);
        const q = round(e.quantity);
        const left = inTransit({ shipped: line.shippedQuantity, received: line.receivedQuantity, writtenOff: line.writtenOffQuantity, returned: line.returnedQuantity });
        const name = facts.get(line.productId)?.name ?? line.productId;
        if (!Number.isFinite(q) || q <= 0 || q > left) throw new StockError(`Settle from more than zero up to ${String(left)} of "${name}".`, 'BAD_QUANTITY');
        // Callers outside the type system (a form) can send anything.
        const action: string = e.action;
        if (action !== 'write_off' && action !== 'return_to_source') throw new StockError('Choose what to do: write it off or send it back.', 'BAD_ACTION');
        const base = { companyId, productId: line.productId, unitCost: Number(line.unitCost), documentType: 'stock_transfer', documentId: doc.id, actor: { type: 'user' as const, id: actor.id } };
        if (action === 'write_off') {
          await this.deps.ledger.post(tx, { ...base, documentLineId: `${line.id}:lost:${String(step)}`, locationId: doc.transitLocationId, type: 'write_off', quantity: -q, reasonCode: 'lost_in_transit', note: `Lost on ${doc.number}: ${why}`.slice(0, 500) });
          await journalChange(tx, { productId: line.productId, delta: -q, changeType: 'damage_writeoff', referenceId: doc.number, actor: 'stock_transfer', note: `Lost in transit on ${doc.number}: ${why}` });
          line.writtenOffQuantity = round(line.writtenOffQuantity + q);
        } else {
          await this.deps.ledger.post(tx, { ...base, documentLineId: `${line.id}:back:${String(step)}`, locationId: doc.transitLocationId, type: 'transfer_out', quantity: -q, note: `Sent back on ${doc.number}` });
          await this.deps.ledger.post(tx, { ...base, documentLineId: `${line.id}:back:${String(step)}`, locationId: doc.fromLocationId ?? '', type: 'transfer_in', quantity: q, note: `Came back on ${doc.number}` });
          line.returnedQuantity = round(line.returnedQuantity + q);
        }
        await tx.update(stockDocumentLines).set({ writtenOffQuantity: line.writtenOffQuantity, returnedQuantity: line.returnedQuantity }).where(eq(stockDocumentLines.id, line.id));
      }
      return { state: await this.settle(tx, doc, lines, actor, 'settled', why) };
    });
  }

  /** Works out the state after a receipt or a settlement and writes it; a finished transfer stops its transit location. */
  private async settle(tx: Tx, doc: StockDocumentRow, lines: StockDocumentLineRow[], actor: DocActor, doing: 'received' | 'settled', reason?: string): Promise<string> {
    const next = stateAfterMovement(lines.map((l) => ({ shipped: l.shippedQuantity, received: l.receivedQuantity, writtenOff: l.writtenOffQuantity, returned: l.returnedQuantity })));
    const finished = next === 'received' || next === 'closed';
    await touch(tx, doc.id, { state: next, lastReceivedAt: doing === 'received' ? sql`now()` : doc.lastReceivedAt, closedAt: finished ? sql`now()` : null });
    if (finished && doc.transitLocationId !== null) {
      await tx.update(stockLocations).set({ isActive: false, updatedAt: sql`now()` }).where(eq(stockLocations.id, doc.transitLocationId));
    }
    await logStep(this.deps, tx, doc, doing, actor, doc.state, next, { reason, outcome: { received: lines.map((l) => l.receivedQuantity).reduce((a, b) => a + b, 0) } });
    return next;
  }

  /** Transfers waiting for someone: a page at a time, oldest first, by state. */
  async list(companyId: string, filter: { states?: string[]; limit?: number } = {}): Promise<StockDocumentRow[]> {
    const states = filter.states;
    return await this.deps.db
      .select()
      .from(stockDocuments)
      .where(and(eq(stockDocuments.companyId, companyId), eq(stockDocuments.kind, 'transfer'), states === undefined ? undefined : sql`${stockDocuments.state} IN (${sql.join(states.map((s) => sql`${s}`), sql`, `)})`))
      .orderBy(asc(stockDocuments.createdAt))
      .limit(Math.min(filter.limit ?? 50, 200));
  }
}
