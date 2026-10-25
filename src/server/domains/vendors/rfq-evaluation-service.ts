import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { reasonCodes, rfqAwards, rfqInvitations, rfqLines, rfqQuoteLines, rfqQuotes, rfqs, vendors } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { compare, type CompareCell, type CompareInput } from '@/lib/rfq';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { RfqService } from './rfq-service';
import type { VendorNotifier } from './notifier';

export const RFQ_REJECTION = 'rfq_rejection';

const REASONS = [
  { code: 'RFQ_PRICE', description: 'The price is higher than we can accept', requiresComment: false },
  { code: 'RFQ_NOT_COMPLIANT', description: 'The quote does not meet the specification', requiresComment: true },
  { code: 'RFQ_DELIVERY', description: 'The delivery time does not suit us', requiresComment: false },
  { code: 'RFQ_INCOMPLETE', description: 'The quote is incomplete', requiresComment: false },
  { code: 'RFQ_OTHER', description: 'Another reason (explain)', requiresComment: true },
] as const;

const HOUR = 3_600_000;
const toCents = (v: string): number => Math.round(Number(v) * 100);

export interface Allocation {
  rfqLineId: string;
  vendorId: string;
  quantity: string;
}

/**
 * The buyer's side once quotes exist (design doc §8.5): reading them only when they may be opened, comparing them, accepting,
 * refusing or asking for a revision of each, and awarding line by line. A sealed request's quotes are opened by the database's
 * own clock (`rfq_quotes_open`), asked here on the one path that reads them.
 */
export class RfqEvaluationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rfqService: RfqService,
    private readonly reasons: ReasonCodes,
    private readonly notify?: VendorNotifier,
  ) {}

  async ensureReasons(companyId: string): Promise<void> {
    await this.db
      .insert(reasonCodes)
      .values(REASONS.map((r) => ({ companyId, code: r.code, description: r.description, requiresComment: r.requiresComment, appliesTo: [RFQ_REJECTION], isSystem: true })))
      .onConflictDoNothing({ target: [reasonCodes.companyId, reasonCodes.code] });
  }

  private async rfqOf(companyId: string, rfqId: string) {
    const [r] = await this.db.select().from(rfqs).where(and(eq(rfqs.companyId, companyId), eq(rfqs.id, rfqId)));
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That request for quotation does not exist.');
    return r;
  }

  private async isOpen(rfqId: string): Promise<boolean> {
    const rows = await this.db.execute<{ open: boolean }>(sql`SELECT rfq_quotes_open(${rfqId}::uuid) AS open`);
    return [...rows][0]?.open === true;
  }

  /**
   * The quotes and the comparison. Before they may be opened this says only how many have arrived and when they open: not who sent
   * them, and not what they say.
   */
  async quotes(companyId: string, rfqId: string) {
    const r = await this.rfqOf(companyId, rfqId);
    if (!(await this.isOpen(rfqId))) {
      const [n] = await this.db.select({ n: sql<number>`count(DISTINCT vendor_id)::int` }).from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.status, 'submitted')));
      return { sealed: true as const, opensAt: r.opensAt?.toISOString() ?? null, received: n?.n ?? 0 };
    }
    const [lines, invitations, allQuotes] = await Promise.all([
      this.db.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId)).orderBy(asc(rfqLines.position)),
      this.db.select({ i: rfqInvitations, name: vendors.legalName, number: vendors.number }).from(rfqInvitations).innerJoin(vendors, eq(vendors.id, rfqInvitations.vendorId)).where(eq(rfqInvitations.rfqId, rfqId)).orderBy(asc(vendors.legalName)),
      this.db.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), inArray(rfqQuotes.status, ['submitted', 'withdrawn']))).orderBy(desc(rfqQuotes.version)),
    ]);
    const latest = new Map<string, (typeof allQuotes)[number]>();
    for (const q of allQuotes) if (q.status === 'submitted' && !latest.has(q.vendorId)) latest.set(q.vendorId, q);
    const ids = [...latest.values()].map((q) => q.id);
    const qlines = ids.length === 0 ? [] : await this.db.select().from(rfqQuoteLines).where(inArray(rfqQuoteLines.quoteId, ids));
    const inputs: CompareInput[] = [];
    const vendorsOut = invitations.map(({ i, name, number }) => {
      const q = latest.get(i.vendorId);
      const own = q === undefined ? [] : qlines.filter((l) => l.quoteId === q.id);
      if (q !== undefined) {
        const cells: Record<string, CompareCell> = {};
        for (const l of own.filter((x) => !x.isAlternative)) {
          const price = l.unitPrice === null ? 0 : toCents(l.unitPrice);
          const qty = l.quantity === null ? 0 : Number(l.quantity);
          cells[l.rfqLineId] = { noBid: l.noBid, unitPrice: price, quantity: qty, lineTotal: Math.round(price * qty), leadTimeDays: l.leadTimeDays };
        }
        inputs.push({ vendorId: i.vendorId, cells, taxTotal: toCents(q.taxTotal) });
      }
      return {
        vendorId: i.vendorId,
        name,
        number,
        invitation: i.status,
        declineReason: i.declineReason,
        decision: i.decision,
        decisionReason: i.decisionReason,
        decisionComment: i.decisionComment,
        revisionDue: i.revisionDue?.toISOString() ?? null,
        versions: allQuotes.filter((x) => x.vendorId === i.vendorId).map((x) => ({ version: x.version, status: x.status, total: x.total, submittedAt: x.submittedAt?.toISOString() ?? null })),
        quote: q === undefined ? null : {
          id: q.id,
          version: q.version,
          paymentTerms: q.paymentTerms,
          deliveryTerms: q.deliveryTerms,
          validUntil: q.validUntil,
          notes: q.notes,
          subtotal: q.subtotal,
          taxTotal: q.taxTotal,
          total: q.total,
          lines: own.map((l) => ({ id: l.id, rfqLineId: l.rfqLineId, noBid: l.noBid, isAlternative: l.isAlternative, unitPrice: l.unitPrice, quantity: l.quantity, taxRate: l.taxRate, leadTimeDays: l.leadTimeDays, brand: l.brand, warranty: l.warranty, note: l.note })),
        },
      };
    });
    const sheet = compare(lines.map((l) => l.id), inputs);
    return { sealed: false as const, lines: lines.map((l) => ({ id: l.id, position: l.position, description: l.description, quantity: l.quantity, unit: l.unit })), vendors: vendorsOut, sheet };
  }

  /** Accept a quote for award, refuse it with a reason, or ask the vendor to revise it. Only on a closed request whose quotes are open. */
  async decide(ctx: FinanceContext, rfqId: string, vendorId: string, action: 'accept' | 'reject' | 'revise', input: { reasonCode?: string; text?: string; due?: string }, now: Date = new Date()): Promise<void> {
    await this.ensureReasons(ctx.companyId);
    const r = await this.rfqOf(ctx.companyId, rfqId);
    if (r.status !== 'closed') throw new FinanceError('NOT_CLOSED', 'Quotes are decided once the request is closed.');
    if (!(await this.isOpen(rfqId))) throw new FinanceError('SEALED', 'These quotes cannot be opened yet.');
    const reason = action === 'reject' ? await this.reasons.require(ctx.companyId, { code: input.reasonCode, text: input.text }, RFQ_REJECTION) : null;
    const note = trimToNull(input.text);
    let due: Date | null = null;
    if (action === 'revise') {
      if (!has(note)) throw new FinanceError('NOTE_REQUIRED', 'Say what the vendor must change.');
      due = new Date(input.due ?? '');
      if (Number.isNaN(due.getTime()) || due.getTime() < now.getTime() + HOUR) throw new FinanceError('INVALID', 'Give a date and time for the revision at least an hour from now.');
    }
    await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, vendorId))).for('update');
      if (inv === undefined) throw new FinanceError('NOT_FOUND', 'That vendor was not invited.');
      const [sent] = await tx.select({ id: rfqQuotes.id }).from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, vendorId), eq(rfqQuotes.status, 'submitted'))).limit(1);
      if (sent === undefined) throw new FinanceError('NO_QUOTE', 'That vendor has no quote to decide.');
      const decision = ({ accept: 'accepted', reject: 'rejected', revise: 'revision_requested' } as const)[action];
      await tx.update(rfqInvitations).set({ decision, decisionReason: reason?.code ?? null, decisionComment: (reason?.text ?? note)?.slice(0, 1000) ?? null, revisionDue: due, decidedBy: ctx.actor.id, decidedAt: now }).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, vendorId)));
      await this.rfqService.event(tx, ctx, rfqId, `quote_${decision}`, { vendorId, reason: reason?.text ?? reason?.code ?? note, data: due === null ? {} : { due: due.toISOString() } });
    });
    if (action === 'reject' && reason !== null) await this.notify?.quoteRejected(vendorId, r.number ?? '', r.title, [REASONS.find((x) => x.code === reason.code)?.description ?? reason.code, reason.text].filter((x): x is string => has(x)).join(': '));
    if (action === 'revise' && due !== null && note !== null) await this.notify?.quoteRevisionRequested(vendorId, r.number ?? '', r.title, note.slice(0, 1000), due);
  }

  /**
   * Awards quantities line by line to one or several vendors, at the price and quantity each quote gave. Choosing a price that is
   * not the lowest bid for a line needs a written justification. Nothing here moves money: the purchase order is made from this.
   */
  async award(ctx: FinanceContext, rfqId: string, allocations: Allocation[], justification: string, now: Date = new Date()): Promise<{ awarded: number }> {
    if (allocations.length === 0) throw new FinanceError('INVALID', 'Choose what to award, and to whom.');
    const r = await this.rfqOf(ctx.companyId, rfqId);
    if (r.status !== 'closed') throw new FinanceError('NOT_CLOSED', 'A request is awarded once it is closed.');
    if (!(await this.isOpen(rfqId))) throw new FinanceError('SEALED', 'These quotes cannot be opened yet.');
    const note = trimToNull(justification);
    const done = await this.db.transaction(async (tx) => {
      const locked = await this.lockRfq(tx, rfqId);
      if (locked.status !== 'closed') throw new FinanceError('NOT_CLOSED', 'This request was already awarded or changed.');
      const lines = await tx.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId));
      const invitations = await tx.select().from(rfqInvitations).where(eq(rfqInvitations.rfqId, rfqId));
      const quotes = await tx.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.status, 'submitted'))).orderBy(desc(rfqQuotes.version));
      const latest = new Map<string, (typeof quotes)[number]>();
      for (const q of quotes) if (!latest.has(q.vendorId)) latest.set(q.vendorId, q);
      const qlines = latest.size === 0 ? [] : await tx.select().from(rfqQuoteLines).where(inArray(rfqQuoteLines.quoteId, [...latest.values()].map((q) => q.id)));
      const perLine = new Map<string, number>();
      const bids = (lineId: string) => [...latest.entries()].flatMap(([vendorId, q]) => {
        if (invitations.find((i) => i.vendorId === vendorId)?.decision === 'rejected') return [];
        const l = qlines.find((x) => x.quoteId === q.id && x.rfqLineId === lineId && !x.isAlternative && !x.noBid);
        return l === undefined || l.unitPrice === null ? [] : [{ vendorId, line: l }];
      });
      const costly: boolean[] = [];
      const rows = allocations.map((a) => {
        const line = lines.find((l) => l.id === a.rfqLineId);
        if (line === undefined) throw new FinanceError('NOT_FOUND', 'One of those lines is not part of this request.');
        const mine = bids(a.rfqLineId).find((b) => b.vendorId === a.vendorId);
        if (mine === undefined || mine.line.unitPrice === null || mine.line.quantity === null) throw new FinanceError('NO_BID', `That vendor has no standing bid on “${line.description}”.`);
        const qty = Number(a.quantity);
        if (!Number.isFinite(qty) || qty <= 0) throw new FinanceError('INVALID', `Give the quantity to award for “${line.description}”.`);
        if (qty > Number(mine.line.quantity)) throw new FinanceError('INVALID', `That vendor offered only ${mine.line.quantity} of “${line.description}”.`);
        const given = (perLine.get(a.rfqLineId) ?? 0) + qty;
        if (given > Number(line.quantity)) throw new FinanceError('INVALID', `More than the ${line.quantity} wanted of “${line.description}” is awarded.`);
        perLine.set(a.rfqLineId, given);
        const lowest = Math.min(...bids(a.rfqLineId).map((b) => toCents(b.line.unitPrice ?? '0')));
        costly.push(toCents(mine.line.unitPrice) > lowest);
        return { rfqId, rfqLineId: a.rfqLineId, vendorId: a.vendorId, quoteLineId: mine.line.id, quantity: String(qty), unitPrice: mine.line.unitPrice, justification: note?.slice(0, 1000) ?? null, awardedBy: ctx.actor.id };
      });
      if (costly.includes(true) && !has(note)) throw new FinanceError('JUSTIFICATION_REQUIRED', 'You chose a vendor who is not the lowest bid on a line. Write why.');
      await tx.insert(rfqAwards).values(rows);
      const awardedVendors = [...new Set(rows.map((x) => x.vendorId))];
      await tx.update(rfqs).set({ status: 'awarded', awardedAt: now, awardNote: note?.slice(0, 1000) ?? null, updatedAt: now }).where(eq(rfqs.id, rfqId));
      await tx.update(rfqInvitations).set({ decision: 'accepted', decidedBy: ctx.actor.id, decidedAt: now }).where(and(eq(rfqInvitations.rfqId, rfqId), inArray(rfqInvitations.vendorId, awardedVendors)));
      await this.rfqService.event(tx, ctx, rfqId, 'awarded', { reason: note, data: { lines: rows.length, vendors: awardedVendors.length } });
      return { awardedVendors, quoted: [...latest.keys()], count: rows.length };
    });
    for (const v of done.quoted) await this.notify?.rfqResult(v, r.number ?? '', r.title, done.awardedVendors.includes(v));
    return { awarded: done.count };
  }

  private async lockRfq(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], rfqId: string) {
    const [r] = await tx.select().from(rfqs).where(eq(rfqs.id, rfqId)).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That request for quotation does not exist.');
    return r;
  }

  async awards(companyId: string, rfqId: string) {
    await this.rfqOf(companyId, rfqId);
    return await this.db
      .select({ id: rfqAwards.id, rfqLineId: rfqAwards.rfqLineId, vendorId: rfqAwards.vendorId, vendorName: vendors.legalName, quantity: rfqAwards.quantity, unitPrice: rfqAwards.unitPrice, justification: rfqAwards.justification, description: rfqLines.description })
      .from(rfqAwards)
      .innerJoin(vendors, eq(vendors.id, rfqAwards.vendorId))
      .innerJoin(rfqLines, eq(rfqLines.id, rfqAwards.rfqLineId))
      .where(eq(rfqAwards.rfqId, rfqId))
      .orderBy(asc(rfqLines.position));
  }
}
