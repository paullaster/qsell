import { and, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { courierInvoiceCharges, courierInvoices, deliveries, deliveryCosts } from '@/server/db/drizzle/schema';
import { INVOICE_WORDS, chargeIds, invoiceProblem, reconcile, type InvoiceState } from '@/lib/courier-invoice';
import { money } from '@/lib/delivery-cost';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { DocActor, DocRefusal, DocResult } from './documents';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const PAGE = 20;
const CANDIDATES = 100;

export interface InvoiceView {
  id: string;
  courierName: string;
  invoiceNo: string;
  invoiceDate: string;
  total: string;
  currency: string;
  note: string | null;
  createdAt: string;
  voided: { at: string; by: string; reason: string } | null;
  matchedCount: number;
  matched: string;
  /** The charges matched less the invoice: below nothing is short, above nothing is over. */
  difference: string;
  state: InvoiceState;
  stateWords: string;
}

export interface ChargeView {
  costId: string;
  amount: string;
  currency: string;
  deliveryNumber: string | null;
  note: string | null;
  createdAt: string;
}

export interface Unbilled {
  courier: string;
  count: number;
  total: string;
}

/** Thrown inside a transaction so a refusal rolls it back. */
class Refused extends Error {
  constructor(
    readonly reason: DocRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Courier invoices matched to the charges we have kept for the courier's parcels. A charge counts only when it was not taken back and is
 * not on another invoice; it can be on one invoice only (a unique key, so two people matching at once cannot count it twice). An invoice
 * says where it stands (nothing matched, agreeing, or short or over by the difference); the office decides what to do about a difference.
 * Matching changes no cost and posts nothing: it is a check, and paying the invoice is done in the usual way.
 */
export class CourierInvoices {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async add(actor: DocActor, input: { courierName?: unknown; invoiceNo?: unknown; invoiceDate?: unknown; total?: unknown; note?: unknown }): Promise<DocResult<{ id: string }>> {
    const read = invoiceProblem(input, businessDate());
    if ('error' in read) return fail('bad_input', read.error);
    const v = read.value;
    const [{ currency } = { currency: 'KES' }] = await this.db.select({ currency: sql<string>`coalesce(max(${deliveryCosts.currency}), 'KES')` }).from(deliveryCosts).where(eq(deliveryCosts.companyId, actor.companyId));
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string }>> => {
        const [row] = await tx
          .insert(courierInvoices)
          .values({ companyId: actor.companyId, courierName: v.courierName, invoiceNo: v.invoiceNo, invoiceDate: v.invoiceDate, total: money(v.totalCents), currency, note: v.note, createdBy: actor.userId })
          .onConflictDoNothing()
          .returning({ id: courierInvoices.id });
        if (row === undefined) return fail('conflict', `${v.courierName} invoice ${v.invoiceNo} is already recorded.`);
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_invoice', id: row.id }, action: 'courier_invoice.added', actor: { type: 'user', id: actor.userId }, outcome: { courier: v.courierName, invoiceNo: v.invoiceNo, total: money(v.totalCents) } }, tx);
        return { ok: true, data: { id: row.id } };
    });
  }

  /** Invoices, newest first, one page at a time, with where each stands. The voided ones are kept and marked. */
  async list(companyId: string, input: { courier?: unknown; cursor?: unknown }): Promise<{ rows: InvoiceView[]; nextCursor: string | null }> {
    const courier = typeof input.courier === 'string' && input.courier.trim() !== '' ? input.courier.trim() : null;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select({ i: courierInvoices, cursorKey: sql<string>`${courierInvoices.createdAt}::text` })
      .from(courierInvoices)
      .where(
        and(
          eq(courierInvoices.companyId, companyId),
          courier === null ? undefined : sql`lower(${courierInvoices.courierName}) = lower(${courier})`,
          after === null ? undefined : sql`(${courierInvoices.createdAt}, ${courierInvoices.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(courierInvoices.createdAt), desc(courierInvoices.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const sums = page.length === 0 ? [] : await this.db
      .select({ invoiceId: courierInvoiceCharges.invoiceId, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${deliveryCosts.amount}), 0)` })
      .from(courierInvoiceCharges)
      .innerJoin(deliveryCosts, eq(deliveryCosts.id, courierInvoiceCharges.costId))
      .where(inArray(courierInvoiceCharges.invoiceId, page.map((p) => p.i.id)))
      .groupBy(courierInvoiceCharges.invoiceId);
    const last = page[page.length - 1];
    return {
      rows: page.map((p) => this.view(p.i, sums.find((s) => s.invoiceId === p.i.id))),
      nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.i.id }) : null,
    };
  }

  private view(i: typeof courierInvoices.$inferSelect, sum: { n: number; total: string } | undefined): InvoiceView {
    const matchedCents = cents(sum?.total);
    const r = reconcile(cents(i.total), matchedCents);
    return {
      id: i.id,
      courierName: i.courierName,
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate,
      total: i.total,
      currency: i.currency,
      note: i.note,
      createdAt: i.createdAt.toISOString(),
      voided: i.voidedAt === null ? null : { at: i.voidedAt.toISOString(), by: i.voidedBy ?? '', reason: i.voidReason ?? '' },
      matchedCount: sum?.n ?? 0,
      matched: money(matchedCents),
      difference: money(r.differenceCents),
      state: r.state,
      stateWords: INVOICE_WORDS[r.state],
    };
  }

  /** The charges matched to one invoice, oldest first. */
  async matchedCharges(companyId: string, invoiceId: string): Promise<ChargeView[]> {
    if (!UUID.test(invoiceId)) return [];
    const rows = await this.db
      .select({ c: deliveryCosts, number: deliveries.number })
      .from(courierInvoiceCharges)
      .innerJoin(deliveryCosts, eq(deliveryCosts.id, courierInvoiceCharges.costId))
      .leftJoin(deliveries, eq(deliveries.id, deliveryCosts.deliveryId))
      .where(and(eq(courierInvoiceCharges.companyId, companyId), eq(courierInvoiceCharges.invoiceId, invoiceId)))
      .orderBy(deliveryCosts.createdAt, deliveryCosts.id);
    return rows.map((r) => ({ costId: r.c.id, amount: r.c.amount, currency: r.c.currency, deliveryNumber: r.number, note: r.c.note, createdAt: r.c.createdAt.toISOString() }));
  }

  /** The courier's charges that could go on this invoice: not taken back and not on any invoice, newest first (the latest hundred). */
  async candidates(companyId: string, invoiceId: string): Promise<{ rows: ChargeView[]; more: boolean }> {
    if (!UUID.test(invoiceId)) return { rows: [], more: false };
    const [inv] = await this.db.select().from(courierInvoices).where(and(eq(courierInvoices.id, invoiceId), eq(courierInvoices.companyId, companyId)));
    if (inv?.voidedAt !== null) return { rows: [], more: false };
    const rows = await this.db
      .select({ c: deliveryCosts, number: deliveries.number })
      .from(deliveryCosts)
      .leftJoin(deliveries, eq(deliveries.id, deliveryCosts.deliveryId))
      .where(and(...this.openCharge(companyId), sql`lower(${deliveryCosts.courierName}) = lower(${inv.courierName})`))
      .orderBy(desc(deliveryCosts.createdAt), desc(deliveryCosts.id))
      .limit(CANDIDATES + 1);
    return { rows: rows.slice(0, CANDIDATES).map((r) => ({ costId: r.c.id, amount: r.c.amount, currency: r.c.currency, deliveryNumber: r.number, note: r.c.note, createdAt: r.c.createdAt.toISOString() })), more: rows.length > CANDIDATES };
  }

  /** A courier charge that counts: a charge (not a reversal), not taken back, and on no invoice. */
  private openCharge(companyId: string) {
    return [
      eq(deliveryCosts.companyId, companyId),
      eq(deliveryCosts.kind, 'courier'),
      isNull(deliveryCosts.reversesId),
      sql`NOT EXISTS (SELECT 1 FROM delivery_costs r WHERE r.reverses_id = ${deliveryCosts.id})`,
      notExists(this.db.select({ x: sql`1` }).from(courierInvoiceCharges).where(eq(courierInvoiceCharges.costId, deliveryCosts.id))),
    ];
  }

  /** Courier charges that are on no invoice yet, by courier: what has been charged to us and not yet billed to us on paper. */
  async unbilled(companyId: string): Promise<Unbilled[]> {
    const rows = await this.db
      .select({ courier: sql<string>`coalesce(${deliveryCosts.courierName}, '')`, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${deliveryCosts.amount}), 0)` })
      .from(deliveryCosts)
      .where(and(...this.openCharge(companyId)))
      .groupBy(sql`coalesce(${deliveryCosts.courierName}, '')`)
      .orderBy(sql`coalesce(${deliveryCosts.courierName}, '')`);
    return rows.map((r) => ({ courier: r.courier, count: r.n, total: money(cents(r.total)) }));
  }

  /** Counts these charges on the invoice. All or none: one that does not belong refuses the lot, and says which kind of reason. */
  async match(actor: DocActor, invoiceId: string, input: { costIds?: unknown }): Promise<DocResult<InvoiceView>> {
    const ids = chargeIds(input.costIds);
    if (!ids.ok) return fail('bad_input', ids.error);
    if (!UUID.test(invoiceId)) return fail('not_found', 'That invoice could not be found.');
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<InvoiceView>> => {
        const [inv] = await tx.select().from(courierInvoices).where(and(eq(courierInvoices.id, invoiceId), eq(courierInvoices.companyId, actor.companyId))).for('update');
        if (inv === undefined) throw new Refused('not_found', 'That invoice could not be found.');
        if (inv.voidedAt !== null) throw new Refused('not_allowed', 'That invoice was voided; charges cannot be matched to it.');
        const found = await tx.select().from(deliveryCosts).where(and(eq(deliveryCosts.companyId, actor.companyId), inArray(deliveryCosts.id, ids.ids)));
        if (found.length !== ids.ids.length) throw new Refused('not_found', 'One of the charges could not be found.');
        for (const c of found) {
          if (c.kind !== 'courier' || c.reversesId !== null || (c.courierName ?? '').toLowerCase() !== inv.courierName.toLowerCase()) throw new Refused('bad_input', `Only ${inv.courierName}'s charges can be matched to this invoice.`);
        }
        const reversed = await tx.select({ id: deliveryCosts.reversesId }).from(deliveryCosts).where(inArray(deliveryCosts.reversesId, ids.ids));
        if (reversed.length > 0) throw new Refused('conflict', 'One of the charges was taken back; it cannot be matched.');
        const made = await tx.insert(courierInvoiceCharges).values(ids.ids.map((costId) => ({ companyId: actor.companyId, invoiceId, costId, matchedBy: actor.userId }))).onConflictDoNothing().returning({ id: courierInvoiceCharges.id });
        if (made.length !== ids.ids.length) throw new Refused('conflict', 'One of the charges is already on an invoice.');
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_invoice', id: invoiceId }, action: 'courier_invoice.matched', actor: { type: 'user', id: actor.userId }, outcome: { charges: ids.ids.length } }, tx);
        return { ok: true, data: await this.one(tx, actor.companyId, invoiceId) };
      });
    } catch (error) {
      if (error instanceof Refused) return fail(error.reason, error.message);
      throw error;
    }
  }

  /** Takes one charge off an invoice (it was counted by mistake). The charge stays kept and can go on another invoice. */
  async unmatch(actor: DocActor, invoiceId: string, input: { costId?: unknown }): Promise<DocResult<InvoiceView>> {
    if (!UUID.test(invoiceId) || typeof input.costId !== 'string' || !UUID.test(input.costId)) return fail('not_found', 'That charge could not be found.');
    const costId = input.costId;
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<InvoiceView>> => {
        const [inv] = await tx.select().from(courierInvoices).where(and(eq(courierInvoices.id, invoiceId), eq(courierInvoices.companyId, actor.companyId))).for('update');
        if (inv === undefined) throw new Refused('not_found', 'That invoice could not be found.');
        if (inv.voidedAt !== null) throw new Refused('not_allowed', 'That invoice was voided.');
        const gone = await tx.delete(courierInvoiceCharges).where(and(eq(courierInvoiceCharges.invoiceId, invoiceId), eq(courierInvoiceCharges.costId, costId))).returning({ id: courierInvoiceCharges.id });
        if (gone.length === 0) throw new Refused('not_found', 'That charge is not on this invoice.');
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_invoice', id: invoiceId }, action: 'courier_invoice.unmatched', actor: { type: 'user', id: actor.userId }, outcome: { costId } }, tx);
        return { ok: true, data: await this.one(tx, actor.companyId, invoiceId) };
      });
    } catch (error) {
      if (error instanceof Refused) return fail(error.reason, error.message);
      throw error;
    }
  }

  /** Voids an invoice that was typed wrongly, with the reason; its charges are free to go on another invoice. Its words are kept. */
  async voidInvoice(actor: DocActor, invoiceId: string, input: { reason?: unknown }): Promise<DocResult<InvoiceView>> {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
    if (reason.length < 5) return fail('bad_input', 'Say why this invoice is being voided, in a few words.');
    if (!UUID.test(invoiceId)) return fail('not_found', 'That invoice could not be found.');
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<InvoiceView>> => {
        const [inv] = await tx.select().from(courierInvoices).where(and(eq(courierInvoices.id, invoiceId), eq(courierInvoices.companyId, actor.companyId))).for('update');
        if (inv === undefined) throw new Refused('not_found', 'That invoice could not be found.');
        if (inv.voidedAt !== null) throw new Refused('conflict', 'That invoice is already voided.');
        const freed = await tx.delete(courierInvoiceCharges).where(eq(courierInvoiceCharges.invoiceId, invoiceId)).returning({ id: courierInvoiceCharges.id });
        await tx.update(courierInvoices).set({ voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason }).where(eq(courierInvoices.id, invoiceId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_invoice', id: invoiceId }, action: 'courier_invoice.voided', actor: { type: 'user', id: actor.userId }, reason: { text: reason }, outcome: { chargesFreed: freed.length } }, tx);
        return { ok: true, data: await this.one(tx, actor.companyId, invoiceId) };
      });
    } catch (error) {
      if (error instanceof Refused) return fail(error.reason, error.message);
      throw error;
    }
  }

  private async one(db: DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], companyId: string, invoiceId: string): Promise<InvoiceView> {
    const [i] = await db.select().from(courierInvoices).where(and(eq(courierInvoices.id, invoiceId), eq(courierInvoices.companyId, companyId)));
    if (i === undefined) throw new Error('The invoice could not be read.');
    const [sum] = await db
      .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${deliveryCosts.amount}), 0)` })
      .from(courierInvoiceCharges)
      .innerJoin(deliveryCosts, eq(deliveryCosts.id, courierInvoiceCharges.costId))
      .where(eq(courierInvoiceCharges.invoiceId, invoiceId));
    return this.view(i, sum);
  }
}
