import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  glAccounts,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  rgnLines,
  rgns,
  supplierInvoiceDeliveryNotes,
  supplierInvoiceEvents,
  supplierInvoiceLineRgn,
  supplierInvoiceLines,
  supplierInvoiceMatches,
  supplierInvoices,
  users,
  vendorAdvancePayments,
  vendorFiles,
  vendors,
  type SupplierInvoiceRow,
  type SupplierInvoiceState,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import {
  INVOICE_REASONS,
  IN_QUEUE,
  STAFF_RETURNABLE,
  approvalSeparation,
  matchLine,
  reasonLabel,
  suggestLinks,
} from '@/lib/supplier-invoice';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { heldByOthers, tolerancesOf, writeEvent, type Tx } from './invoice-support';
import type { VendorNotifier } from './notifier';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const LINKABLE: SupplierInvoiceState[] = ['received', 'rgn_linked', 'matched'];
const MAX_NOTE = 500;

export interface LinkInput {
  lineId: string;
  rgnLineId: string;
  quantity: string;
}
export interface LinksInput {
  links: LinkInput[];
  accounts: { lineId: string; glAccountId: string | null }[];
  notes: { noteId: string; rgnId: string | null }[];
}

/**
 * The staff side of supplier invoices (design doc §11.4 to §11.7). An invoice moves one way through pick-up, linking the
 * received goods, the match, approval and booking; staff can send it back at any point before it is booked. Every move is
 * written to the invoice's history, and whoever linked or checked an invoice cannot approve it.
 */
export class SupplierInvoiceService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
  ) {}

  private async lock(tx: Tx, companyId: string, id: string): Promise<SupplierInvoiceRow> {
    const [inv] = await tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.companyId, companyId), eq(supplierInvoices.id, id))).for('update');
    if (inv === undefined || inv.state === 'draft') throw new FinanceError('NOT_FOUND', 'That invoice does not exist.');
    return inv;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async queue(companyId: string, filter: { state?: string; vendorId?: string; assignedTo?: string; before?: { stamp: string; id: string } | null }, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const stamp = sql<string>`COALESCE(${supplierInvoices.submittedAt}, ${supplierInvoices.createdAt})::text`;
    const state = has(filter.state) ? filter.state : null;
    const conds = [
      eq(supplierInvoices.companyId, companyId),
      state === null ? inArray(supplierInvoices.state, [...IN_QUEUE]) : eq(supplierInvoices.state, state as SupplierInvoiceState),
      ...(state === 'draft' ? [sql`false`] : []),
      ...(has(filter.vendorId) ? [eq(supplierInvoices.vendorId, filter.vendorId)] : []),
      ...(has(filter.assignedTo) ? [eq(supplierInvoices.assignedTo, filter.assignedTo)] : []),
      ...(filter.before === undefined || filter.before === null ? [] : [sql`(COALESCE(${supplierInvoices.submittedAt}, ${supplierInvoices.createdAt})::text, ${supplierInvoices.id}::text) < (${filter.before.stamp}, ${filter.before.id})`]),
    ];
    const found = await this.db
      .select({ i: supplierInvoices, vendorName: vendors.legalName, orderNumber: purchaseOrders.number, stamp })
      .from(supplierInvoices)
      .innerJoin(vendors, eq(vendors.id, supplierInvoices.vendorId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId))
      .where(and(...conds))
      .orderBy(sql`COALESCE(${supplierInvoices.submittedAt}, ${supplierInvoices.createdAt}) DESC`, desc(supplierInvoices.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const names = await this.names(page.map((x) => x.i.assignedTo));
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({
        id: x.i.id,
        number: x.i.number,
        vendorInvoiceNo: x.i.vendorInvoiceNo,
        state: x.i.state,
        vendorName: x.vendorName,
        orderNumber: x.orderNumber ?? '',
        total: x.i.total,
        currency: x.i.currency,
        submittedAt: x.i.submittedAt?.toISOString() ?? null,
        assignedTo: x.i.assignedTo === null ? null : (names.get(x.i.assignedTo) ?? 'Someone'),
        revision: x.i.revision,
      })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.i.id } : null,
    };
  }

  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const clean = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    if (clean.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, clean));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Everything the workspace shows: the invoice, the order it is for, the received goods to choose from, the match and the history. */
  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ i: supplierInvoices, vendorName: vendors.legalName, vendorNumber: vendors.number, po: purchaseOrders })
      .from(supplierInvoices)
      .innerJoin(vendors, eq(vendors.id, supplierInvoices.vendorId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId))
      .where(and(eq(supplierInvoices.companyId, companyId), eq(supplierInvoices.id, id)));
    if (head === undefined || head.i.state === 'draft') return null;
    const inv = head.i;
    const [lines, links, matches, notes, events, orderLines, rgnRows, file, tol] = await Promise.all([
      this.db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.position)),
      this.db
        .select({ l: supplierInvoiceLineRgn, number: rgns.number, noteNo: rgns.deliveryNoteNo })
        .from(supplierInvoiceLineRgn)
        .innerJoin(supplierInvoiceLines, eq(supplierInvoiceLines.id, supplierInvoiceLineRgn.invoiceLineId))
        .innerJoin(rgnLines, eq(rgnLines.id, supplierInvoiceLineRgn.rgnLineId))
        .innerJoin(rgns, eq(rgns.id, rgnLines.rgnId))
        .where(eq(supplierInvoiceLines.invoiceId, id)),
      this.db.select({ m: supplierInvoiceMatches }).from(supplierInvoiceMatches).innerJoin(supplierInvoiceLines, eq(supplierInvoiceLines.id, supplierInvoiceMatches.invoiceLineId)).where(eq(supplierInvoiceLines.invoiceId, id)),
      this.db
        .select({ n: supplierInvoiceDeliveryNotes, fileName: vendorFiles.fileName, rgnNumber: rgns.number })
        .from(supplierInvoiceDeliveryNotes)
        .innerJoin(vendorFiles, eq(vendorFiles.id, supplierInvoiceDeliveryNotes.fileId))
        .leftJoin(rgns, eq(rgns.id, supplierInvoiceDeliveryNotes.matchedRgnId))
        .where(eq(supplierInvoiceDeliveryNotes.invoiceId, id)),
      this.db.select().from(supplierInvoiceEvents).where(eq(supplierInvoiceEvents.invoiceId, id)).orderBy(desc(supplierInvoiceEvents.id)).limit(100),
      this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId)),
      this.db
        .select({ rl: rgnLines, number: rgns.number, noteNo: rgns.deliveryNoteNo, receivedDate: rgns.receivedDate, rgnId: rgns.id })
        .from(rgnLines)
        .innerJoin(rgns, eq(rgns.id, rgnLines.rgnId))
        .where(and(eq(rgns.poId, inv.poId), eq(rgns.status, 'posted')))
        .orderBy(asc(rgns.postedAt)),
      inv.invoiceFileId === null ? Promise.resolve(undefined) : this.db.select({ id: vendorFiles.id, name: vendorFiles.fileName }).from(vendorFiles).where(eq(vendorFiles.id, inv.invoiceFileId)).then((r) => r[0]),
      tolerancesOf(this.db, companyId),
    ]);
    const [booked] = inv.purchaseInvoiceId === null ? [] : await this.db.select({ id: purchaseInvoices.id, number: purchaseInvoices.number, ledgerEntryId: purchaseInvoices.ledgerEntryId }).from(purchaseInvoices).where(eq(purchaseInvoices.id, inv.purchaseInvoiceId));
    const held = await heldByOthers(this.db, rgnRows.map((r) => r.rl.id), id);
    const accountIds = [...new Set(lines.map((l) => l.glAccountId).filter((x): x is string => x !== null))];
    const accounts = accountIds.length === 0 ? [] : await this.db.select({ id: glAccounts.id, no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(inArray(glAccounts.id, accountIds));
    const accountLabel = new Map(accounts.map((a) => [a.id, `${a.no} ${a.name}`]));
    const names = await this.names([inv.assignedTo, inv.linkedBy, inv.matchedBy, inv.approvedBy, inv.postedBy, ...events.map((e) => e.actorId)]);
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? (x.startsWith('vendor:') ? 'The vendor' : 'Someone')));
    const poLine = new Map(orderLines.map((l) => [l.id, l]));
    const matchOf = new Map(matches.map((m) => [m.m.invoiceLineId, m.m]));
    return {
      invoice: { ...inv, createdAt: inv.createdAt.toISOString(), updatedAt: inv.updatedAt.toISOString() },
      vendorName: head.vendorName,
      vendorNumber: head.vendorNumber,
      bookedInvoice: booked === undefined ? null : { id: booked.id, number: booked.number },
      order: { id: head.po.id, number: head.po.number ?? '', requiresAdvance: head.po.requiresAdvancePayment, currency: head.po.currency },
      invoiceFile: file ?? null,
      assignedName: who(inv.assignedTo),
      linkedName: who(inv.linkedBy),
      matchedName: who(inv.matchedBy),
      approvedName: who(inv.approvedBy),
      tolerances: tol,
      lines: lines.map((l) => {
        const pl = poLine.get(l.poLineId);
        const m = matchOf.get(l.id);
        return {
          id: l.id,
          position: l.position,
          poLineId: l.poLineId,
          description: l.description,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          netAmount: l.netAmount,
          taxAmount: l.taxAmount,
          glAccountId: l.glAccountId,
          glAccountLabel: l.glAccountId === null ? '' : (accountLabel.get(l.glAccountId) ?? ''),
          stock: pl?.productId != null,
          orderPrice: pl === undefined ? '' : (Number(pl.unitPrice) * (1 - Number(pl.discountPercent) / 100)).toFixed(2),
          links: links.filter((k) => k.l.invoiceLineId === l.id).map((k) => ({ rgnLineId: k.l.rgnLineId, quantity: k.l.quantity, rgnNumber: k.number ?? '', noteNo: k.noteNo })),
          match: m === undefined ? null : { status: m.status, problems: m.problems, priceDifference: m.priceDifference, quantityDifference: m.quantityDifference },
        };
      }),
      candidates: rgnRows.map((r) => ({
        rgnLineId: r.rl.id,
        poLineId: r.rl.poLineId,
        rgnNumber: r.number ?? '',
        rgnId: r.rgnId,
        noteNo: r.noteNo,
        receivedDate: r.receivedDate,
        accepted: r.rl.accepted,
        invoiced: r.rl.invoicedQuantity,
        room: String(Math.max(0, round3(Number(r.rl.accepted) - Number(r.rl.invoicedQuantity) - Number(r.rl.returnedQuantity) - (held.get(r.rl.id) ?? 0)))),
      })),
      deliveryNotes: notes.map((x) => ({ id: x.n.id, noteNo: x.n.noteNo, noteDate: x.n.noteDate, fileId: x.n.fileId, fileName: x.fileName, matchedRgnId: x.n.matchedRgnId, matchedRgnNumber: x.rgnNumber })),
      events: events.map((e) => ({ id: e.id, event: e.event, from: e.fromState, to: e.toState, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }

  // ── stages ───────────────────────────────────────────────────────────────

  /** Takes the invoice from the queue. This is the moment the vendor can no longer take it back. */
  async pickUp(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (inv.state !== 'submitted') throw new FinanceError('WRONG_STATE', inv.state === 'received' ? 'Someone has already picked this invoice up.' : 'This invoice is not waiting in the queue.');
      await tx.update(supplierInvoices).set({ state: 'received', assignedTo: ctx.actor.id, firstActionAt: now, updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'picked_up', 'submitted', 'received');
    });
  }

  /** Stage 1. Replaces the links, accounts and delivery-note matches with those given and says whether the stage is complete. */
  async saveLinks(ctx: FinanceContext, id: string, input: LinksInput, now: Date = new Date()): Promise<{ complete: boolean; missing: string[] }> {
    return await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      return await this.applyLinks(tx, ctx, inv, input, now);
    });
  }

  private async applyLinks(tx: Tx, ctx: FinanceContext, inv: SupplierInvoiceRow, input: LinksInput, now: Date): Promise<{ complete: boolean; missing: string[] }> {
    if (!LINKABLE.includes(inv.state)) throw new FinanceError('WRONG_STATE', inv.state === 'submitted' ? 'Pick the invoice up first.' : 'Links can no longer be changed at this stage. Send the invoice back, or return it to the vendor.');
    const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id));
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const rgnIds = [...new Set(input.links.map((l) => l.rgnLineId))];
    const goods = rgnIds.length === 0 ? [] : await tx.select({ rl: rgnLines, rgnPoId: rgns.poId, rgnVendorId: rgns.vendorId, status: rgns.status }).from(rgnLines).innerJoin(rgns, eq(rgns.id, rgnLines.rgnId)).where(inArray(rgnLines.id, rgnIds));
    const goodsById = new Map(goods.map((g) => [g.rl.id, g]));
    const held = await heldByOthers(tx, rgnIds, inv.id);
    const perGoods = new Map<string, number>();
    const perLine = new Map<string, number>();
    const rows: { invoiceLineId: string; rgnLineId: string; quantity: string }[] = [];
    for (const k of input.links) {
      const line = lineById.get(k.lineId);
      const g = goodsById.get(k.rgnLineId);
      const q = Number(k.quantity);
      if (line === undefined) throw new FinanceError('INVALID', 'One of the links is for a line that is not on this invoice.');
      if (g?.status !== 'posted' || g.rgnPoId !== inv.poId || g.rgnVendorId !== inv.vendorId) throw new FinanceError('INVALID', 'You can only link goods that were received, and posted, against this invoice’s order.');
      if (g.rl.poLineId !== line.poLineId) throw new FinanceError('INVALID', `Line ${String(line.position)} is for a different order line than the goods you chose.`);
      if (!/^\d+(\.\d{1,3})?$/.test(k.quantity.trim()) || q <= 0) throw new FinanceError('INVALID', 'Enter the quantity to link as a number above zero.');
      perGoods.set(k.rgnLineId, round3((perGoods.get(k.rgnLineId) ?? 0) + q));
      perLine.set(k.lineId, round3((perLine.get(k.lineId) ?? 0) + q));
      rows.push({ invoiceLineId: k.lineId, rgnLineId: k.rgnLineId, quantity: k.quantity.trim() });
    }
    for (const [rgnLineId, q] of perGoods) {
      const g = goodsById.get(rgnLineId);
      const room = round3(Number(g?.rl.accepted ?? 0) - Number(g?.rl.invoicedQuantity ?? 0) - Number(g?.rl.returnedQuantity ?? 0) - (held.get(rgnLineId) ?? 0));
      if (q > room) throw new FinanceError('TOO_MUCH', `Only ${String(Math.max(room, 0))} of those goods can still be invoiced; other invoices already hold the rest.`);
    }
    for (const [lineId, q] of perLine) {
      const line = lineById.get(lineId);
      if (line !== undefined && q > Number(line.quantity)) throw new FinanceError('TOO_MUCH', `The goods linked to line ${String(line.position)} are more than the invoice charges for.`);
    }
    const accountIds = [...new Set(input.accounts.map((a) => a.glAccountId).filter(has))];
    if (accountIds.length > 0) {
      const ok = await tx.select({ id: glAccounts.id }).from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), inArray(glAccounts.id, accountIds), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.postingSource, 'manual')));
      if (ok.length !== accountIds.length) throw new FinanceError('INVALID', 'Choose accounts that can be posted to (not blocked, not a control account).');
    }
    const notes = await tx.select().from(supplierInvoiceDeliveryNotes).where(eq(supplierInvoiceDeliveryNotes.invoiceId, inv.id));
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const matchedNotes = new Map<string, string | null>();
    for (const n of input.notes) {
      const note = noteById.get(n.noteId);
      if (note === undefined) throw new FinanceError('INVALID', 'One of the delivery notes is not on this invoice.');
      if (n.rgnId === null) {
        matchedNotes.set(note.id, null);
        continue;
      }
      const [r] = await tx.select({ id: rgns.id, noteNo: rgns.deliveryNoteNo }).from(rgns).where(and(eq(rgns.id, n.rgnId), eq(rgns.poId, inv.poId), eq(rgns.vendorId, inv.vendorId), eq(rgns.status, 'posted')));
      if (r === undefined) throw new FinanceError('INVALID', 'That received goods note is not a posted one for this order.');
      if (r.noteNo.trim().toLowerCase() !== note.noteNo.trim().toLowerCase()) throw new FinanceError('INVALID', `Delivery note ${note.noteNo} does not match the number recorded on that received goods note (${r.noteNo}).`);
      matchedNotes.set(note.id, r.id);
    }
    await tx.delete(supplierInvoiceLineRgn).where(inArray(supplierInvoiceLineRgn.invoiceLineId, lines.map((l) => l.id)));
    if (rows.length > 0) await tx.insert(supplierInvoiceLineRgn).values(rows);
    for (const a of input.accounts) {
      if (lineById.has(a.lineId)) await tx.update(supplierInvoiceLines).set({ glAccountId: a.glAccountId }).where(eq(supplierInvoiceLines.id, a.lineId));
    }
    for (const [noteId, rgnId] of matchedNotes) await tx.update(supplierInvoiceDeliveryNotes).set({ matchedRgnId: rgnId }).where(eq(supplierInvoiceDeliveryNotes.id, noteId));
    // A change of links makes any earlier match meaningless.
    await tx.delete(supplierInvoiceMatches).where(inArray(supplierInvoiceMatches.invoiceLineId, lines.map((l) => l.id)));

    const missing: string[] = [];
    if (!inv.advanceBasis) {
      for (const l of lines) if ((perLine.get(l.id) ?? 0) <= 0) missing.push(`Line ${String(l.position)} has no received goods linked.`);
      for (const n of notes) {
        const chosen = matchedNotes.has(n.id) ? matchedNotes.get(n.id) : n.matchedRgnId;
        if (chosen === null || chosen === undefined) missing.push(`Delivery note ${n.noteNo} is not matched to a received goods note. Receive the goods first, or return the invoice.`);
      }
    }
    const complete = missing.length === 0;
    const next: SupplierInvoiceState = complete ? 'rgn_linked' : 'received';
    await tx
      .update(supplierInvoices)
      .set({ state: next, linkedBy: complete ? ctx.actor.id : null, linkedAt: complete ? now : null, matchedBy: null, matchedAt: null, matchOverrideReason: null, updatedAt: now })
      .where(eq(supplierInvoices.id, inv.id));
    await writeEvent(tx, ctx.actor, inv.id, 'linked', inv.state, next, { data: { links: rows.length, complete } });
    return { complete, missing };
  }

  /** Links the oldest received goods first and matches delivery notes by their number, then saves like a person would. */
  async autoLink(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ complete: boolean; missing: string[] }> {
    return await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.position));
      const goods = await tx
        .select({ rl: rgnLines })
        .from(rgnLines)
        .innerJoin(rgns, eq(rgns.id, rgnLines.rgnId))
        .where(and(eq(rgns.poId, inv.poId), eq(rgns.vendorId, inv.vendorId), eq(rgns.status, 'posted')))
        .orderBy(asc(rgns.postedAt));
      const held = await heldByOthers(tx, goods.map((g) => g.rl.id), id);
      const used = new Map<string, number>();
      const links: LinkInput[] = [];
      for (const l of lines) {
        if (inv.advanceBasis) break;
        const candidates = goods
          .filter((g) => g.rl.poLineId === l.poLineId)
          .map((g) => ({ rgnLineId: g.rl.id, room: round3(Number(g.rl.accepted) - Number(g.rl.invoicedQuantity) - Number(g.rl.returnedQuantity) - (held.get(g.rl.id) ?? 0) - (used.get(g.rl.id) ?? 0)) }));
        for (const k of suggestLinks(Number(l.quantity), candidates).links) {
          used.set(k.rgnLineId, round3((used.get(k.rgnLineId) ?? 0) + k.quantity));
          links.push({ lineId: l.id, rgnLineId: k.rgnLineId, quantity: String(k.quantity) });
        }
      }
      const notes = await tx.select().from(supplierInvoiceDeliveryNotes).where(eq(supplierInvoiceDeliveryNotes.invoiceId, id));
      const posted = await tx.select({ id: rgns.id, noteNo: rgns.deliveryNoteNo }).from(rgns).where(and(eq(rgns.poId, inv.poId), eq(rgns.vendorId, inv.vendorId), eq(rgns.status, 'posted')));
      const noteInput = notes.map((n) => ({ noteId: n.id, rgnId: posted.find((r) => r.noteNo.trim().toLowerCase() === n.noteNo.trim().toLowerCase())?.id ?? null }));
      const accounts = lines.filter((l) => l.glAccountId !== null).map((l) => ({ lineId: l.id, glAccountId: l.glAccountId }));
      return await this.applyLinks(tx, ctx, inv, { links, accounts, notes: noteInput }, now);
    });
  }

  /** The match (design doc §11.6). Every line against the order and the goods linked; the result is kept per line. */
  async runMatch(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ ok: boolean; exceptions: number }> {
    return await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (inv.state !== 'rgn_linked' && inv.state !== 'matched') throw new FinanceError('WRONG_STATE', 'Link the received goods first; the check comes after.');
      const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.position));
      const orderLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId));
      const poLine = new Map(orderLines.map((l) => [l.id, l]));
      const links = await tx.select().from(supplierInvoiceLineRgn).where(inArray(supplierInvoiceLineRgn.invoiceLineId, lines.map((l) => l.id)));
      const tol = await tolerancesOf(tx, ctx.companyId);
      const problemsAll: string[] = [];
      let advanceCeilingCents: number | null = null;
      if (inv.advanceBasis) {
        const [adv] = await tx.select({ amount: vendorAdvancePayments.amount }).from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, inv.poId), inArray(vendorAdvancePayments.status, ['approved', 'paid'])));
        advanceCeilingCents = adv === undefined ? 0 : Math.round(Number(adv.amount) * 100);
        if (Math.round(Number(inv.total) * 100) > advanceCeilingCents) problemsAll.push(`The invoice (${inv.total}) is more than the advance payment approved for this order.`);
      }
      const results = lines.map((l) => {
        const pl = poLine.get(l.poLineId);
        const linked = inv.advanceBasis ? Number(l.quantity) : links.filter((k) => k.invoiceLineId === l.id).reduce((s, k) => s + Number(k.quantity), 0);
        const orderPrice = pl === undefined ? 0 : Math.round(Number(pl.unitPrice) * (1 - Number(pl.discountPercent) / 100) * 100);
        const stock = pl?.productId != null;
        return {
          line: l,
          result: matchLine({ invoiceQuantity: Number(l.quantity), invoiceUnitPriceCents: Math.round(Number(l.unitPrice) * 100), invoiceTaxRate: Number(l.taxRate), linkedQuantity: round3(linked), orderUnitPriceCents: orderPrice, orderTaxRate: Number(pl?.taxRate ?? '0'), needsAccount: !stock && !inv.advanceBasis, hasAccount: l.glAccountId !== null }, tol),
        };
      });
      await tx.delete(supplierInvoiceMatches).where(inArray(supplierInvoiceMatches.invoiceLineId, lines.map((l) => l.id)));
      if (results.length > 0) {
        await tx.insert(supplierInvoiceMatches).values(results.map((r) => ({ invoiceLineId: r.line.id, status: r.result.status, problems: r.result.problems, priceDifference: (r.result.priceDifferenceCents / 100).toFixed(2), quantityDifference: String(r.result.quantityDifference) })));
      }
      const exceptions = results.filter((r) => r.result.status === 'exception').length + (problemsAll.length > 0 ? 1 : 0);
      const ok = exceptions === 0;
      if (advanceCeilingCents !== null && problemsAll.length > 0 && results.length > 0) {
        await tx.update(supplierInvoiceMatches).set({ status: 'exception', problems: sql`problems || ${JSON.stringify(problemsAll)}::jsonb` }).where(eq(supplierInvoiceMatches.invoiceLineId, results[0]?.line.id ?? ''));
      }
      await tx
        .update(supplierInvoices)
        .set({ state: ok ? 'matched' : 'rgn_linked', matchedBy: ok ? ctx.actor.id : null, matchedAt: ok ? now : null, matchOverrideReason: null, updatedAt: now })
        .where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, ok ? 'matched' : 'match_exceptions', inv.state, ok ? 'matched' : 'rgn_linked', { data: { exceptions } });
      return { ok, exceptions };
    });
  }

  /** Accepts differences the match found, with a reason. Allowed only for those with the permission (checked by the action). */
  async override(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the differences are accepted.');
    await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (inv.state !== 'rgn_linked') throw new FinanceError('WRONG_STATE', 'Only an invoice whose check found differences can be accepted this way.');
      const lines = await tx.select({ id: supplierInvoiceLines.id }).from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id));
      const found = await tx.select({ status: supplierInvoiceMatches.status }).from(supplierInvoiceMatches).where(inArray(supplierInvoiceMatches.invoiceLineId, lines.map((l) => l.id)));
      if (found.length === 0) throw new FinanceError('NOT_CHECKED', 'Run the check first.');
      await tx.update(supplierInvoices).set({ state: 'matched', matchedBy: ctx.actor.id, matchedAt: now, matchOverrideReason: text.slice(0, MAX_NOTE), updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'match_overridden', 'rgn_linked', 'matched', { reason: text.slice(0, MAX_NOTE) });
    });
  }

  async sendForApproval(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (inv.state !== 'matched') throw new FinanceError('WRONG_STATE', 'Only a checked invoice can be sent for approval.');
      await tx.update(supplierInvoices).set({ state: 'pending_approval', sentForApprovalBy: ctx.actor.id, sentForApprovalAt: now, updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'sent_for_approval', 'matched', 'pending_approval');
    });
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (inv.state !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This invoice is not waiting for approval.');
      const refusal = approvalSeparation(ctx.actor.id ?? '', inv.linkedBy, inv.matchedBy);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', refusal);
      await tx.update(supplierInvoices).set({ state: 'approved', approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'approved', 'pending_approval', 'approved');
    });
  }

  /** Back to the vendor to be corrected. Links, checks and approvals are cleared: the corrected invoice starts again. */
  async returnToVendor(ctx: FinanceContext, id: string, reasonCode: string, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!INVOICE_REASONS.some((r) => r.code === reasonCode)) throw new FinanceError('INVALID', 'Choose a reason.');
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say what the vendor has to fix.');
    const done = await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (!(STAFF_RETURNABLE as readonly string[]).includes(inv.state)) throw new FinanceError('WRONG_STATE', inv.state === 'posted' ? 'A booked invoice cannot be returned. A credit memo corrects it.' : 'This invoice cannot be returned at this stage.');
      await this.clear(tx, id);
      await tx
        .update(supplierInvoices)
        .set({ state: 'returned', returnReasonCode: reasonCode, returnNote: text.slice(0, MAX_NOTE), assignedTo: null, linkedBy: null, linkedAt: null, matchedBy: null, matchedAt: null, matchOverrideReason: null, sentForApprovalBy: null, sentForApprovalAt: null, approvedBy: null, approvedAt: null, updatedAt: now })
        .where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'returned', inv.state, 'returned', { reason: text.slice(0, MAX_NOTE), data: { reasonCode } });
      return inv;
    });
    await this.notify?.invoiceReturned(done.vendorId, done.number ?? '', reasonLabel(reasonCode), text.slice(0, MAX_NOTE));
  }

  async reject(ctx: FinanceContext, id: string, reasonCode: string, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!INVOICE_REASONS.some((r) => r.code === reasonCode)) throw new FinanceError('INVALID', 'Choose a reason.');
    if (reasonCode === 'other' && !has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the invoice is refused.');
    const done = await this.db.transaction(async (tx) => {
      const inv = await this.lock(tx, ctx.companyId, id);
      if (!(STAFF_RETURNABLE as readonly string[]).includes(inv.state)) throw new FinanceError('WRONG_STATE', 'This invoice cannot be refused at this stage.');
      await this.clear(tx, id);
      await tx.update(supplierInvoices).set({ state: 'rejected', rejectReasonCode: reasonCode, rejectNote: text?.slice(0, MAX_NOTE) ?? null, updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'rejected', inv.state, 'rejected', { reason: text?.slice(0, MAX_NOTE) ?? null, data: { reasonCode } });
      return inv;
    });
    await this.notify?.invoiceRefused(done.vendorId, done.number ?? '', reasonLabel(reasonCode), text?.slice(0, MAX_NOTE) ?? '');
  }

  private async clear(tx: Tx, invoiceId: string): Promise<void> {
    const lines = await tx.select({ id: supplierInvoiceLines.id }).from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, invoiceId));
    const ids = lines.map((l) => l.id);
    if (ids.length > 0) {
      await tx.delete(supplierInvoiceLineRgn).where(inArray(supplierInvoiceLineRgn.invoiceLineId, ids));
      await tx.delete(supplierInvoiceMatches).where(inArray(supplierInvoiceMatches.invoiceLineId, ids));
      await tx.update(supplierInvoiceLines).set({ glAccountId: null }).where(inArray(supplierInvoiceLines.id, ids));
    }
    await tx.update(supplierInvoiceDeliveryNotes).set({ matchedRgnId: null }).where(eq(supplierInvoiceDeliveryNotes.invoiceId, invoiceId));
  }

  /** Opens the invoice's scan or one of its delivery notes. Only files that belong to an invoice can be opened this way. */
  async openFile(ctx: FinanceContext, fileId: string) {
    const [inv] = await this.db
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(and(eq(supplierInvoices.companyId, ctx.companyId), eq(supplierInvoices.invoiceFileId, fileId)));
    const [note] = inv === undefined ? await this.db.select({ id: supplierInvoiceDeliveryNotes.invoiceId }).from(supplierInvoiceDeliveryNotes).innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceDeliveryNotes.invoiceId)).where(and(eq(supplierInvoices.companyId, ctx.companyId), eq(supplierInvoiceDeliveryNotes.fileId, fileId))) : [];
    const invoiceId = inv?.id ?? note?.id;
    if (invoiceId === undefined) return null;
    const [f] = await this.db.select({ fileName: vendorFiles.fileName, mime: vendorFiles.mime, data: vendorFiles.data }).from(vendorFiles).where(eq(vendorFiles.id, fileId));
    if (f === undefined) return null;
    await writeEvent(this.db, ctx.actor, invoiceId, 'file_opened', null, null, { data: { fileId, fileName: f.fileName } });
    return f;
  }

  /** How many invoices are in each state, for the queue's tabs. */
  async countsByState(companyId: string): Promise<Record<string, number>> {
    const rows = await this.db.select({ state: supplierInvoices.state, n: sql<number>`count(*)::int` }).from(supplierInvoices).where(eq(supplierInvoices.companyId, companyId)).groupBy(supplierInvoices.state);
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
