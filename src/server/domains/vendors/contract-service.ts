import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { procurementCategories, users, vendorContractEvents, vendorContractLines, vendorContracts, vendors, type VendorContractRow } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkContractHeader, checkContractLine, remainingQuantity, type ContractHeaderForm, type ContractLineForm } from '@/lib/vendor-contract';
import { toCents } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { contractUsage } from './contract-support';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const MAX_LINES = 200;

/**
 * Vendor contracts (blanket orders): agreed prices for a period, with a ceiling on quantity per line and on value. Approved by
 * another person, then immutable (the database refuses changes). Orders are called off by the order service, which counts what
 * has been used from the orders themselves.
 */
export class ContractService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, id: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorContractEvents).values({ contractId: id, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  async lock(tx: Tx, companyId: string, id: string): Promise<VendorContractRow> {
    const [c] = await tx.select().from(vendorContracts).where(and(eq(vendorContracts.companyId, companyId), eq(vendorContracts.id, id))).for('update');
    if (c === undefined) throw new FinanceError('NOT_FOUND', 'That contract does not exist.');
    return c;
  }

  async saveDraft(ctx: FinanceContext, id: string | null, header: ContractHeaderForm, lines: ContractLineForm[]): Promise<{ id: string }> {
    const first = Object.values(checkContractHeader(header))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    if (lines.length === 0) throw new FinanceError('INVALID', 'Add at least one line.');
    if (lines.length > MAX_LINES) throw new FinanceError('TOO_MANY', `A contract can have at most ${String(MAX_LINES)} lines.`);
    lines.forEach((l, i) => {
      const problem = Object.values(checkContractLine(l))[0];
      if (has(problem)) throw new FinanceError('INVALID', `Line ${String(i + 1)}: ${problem}`);
    });
    return await this.db.transaction(async (tx) => {
      const [v] = await tx.select({ status: vendors.status }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, header.vendorId)));
      if (v === undefined || v.status === 'archived') throw new FinanceError('NOT_FOUND', 'That vendor does not exist or is archived.');
      const [cat] = await tx.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, ctx.companyId), eq(procurementCategories.id, header.categoryId)));
      if (cat === undefined || cat.status === 'archived') throw new FinanceError('NOT_FOUND', 'That category does not exist or is archived.');
      const values = { vendorId: header.vendorId, categoryId: header.categoryId, title: header.title.trim(), currency: header.currency.trim().toUpperCase(), validFrom: header.validFrom, validTo: header.validTo, maxValue: trimToNull(header.maxValue), terms: trimToNull(header.terms), updatedAt: new Date() };
      let contractId = id;
      if (id === null) {
        const [made] = await tx.insert(vendorContracts).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...values }).returning({ id: vendorContracts.id });
        contractId = made?.id ?? null;
        if (contractId !== null) await this.event(tx, ctx, contractId, 'created');
      } else {
        const c = await this.lock(tx, ctx.companyId, id);
        if (c.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed. An approved contract is replaced by a new one.');
        await tx.update(vendorContracts).set(values).where(eq(vendorContracts.id, id));
        await tx.delete(vendorContractLines).where(eq(vendorContractLines.contractId, id));
      }
      if (contractId === null) throw new FinanceError('FAILED', 'The contract could not be saved.');
      const cid = contractId;
      await tx.insert(vendorContractLines).values(lines.map((l, i) => ({ contractId: cid, position: i, productId: trimToNull(l.productId), description: l.description.trim(), specification: trimToNull(l.specification), unit: l.unit.trim(), unitPrice: l.unitPrice.trim(), discountPercent: l.discountPercent.trim() === '' ? '0' : l.discountPercent.trim(), taxRate: l.taxRate.trim() === '' ? '0' : l.taxRate.trim(), maxQuantity: trimToNull(l.maxQuantity) })));
      return { id: cid };
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx.companyId, id);
      if (c.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be sent for approval.');
      if (c.createdBy !== ctx.actor.id) throw new FinanceError('NOT_YOURS', 'Only the person who wrote the contract sends it for approval.');
      await tx.update(vendorContracts).set({ status: 'pending_approval', submittedAt: now, rejectReason: null, updatedAt: now }).where(eq(vendorContracts.id, id));
      await this.event(tx, ctx, id, 'submitted');
    });
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx.companyId, id);
      if (c.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This contract is not waiting for approval.');
      if (c.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to approve this contract: you wrote it.');
      const number = (await this.numbering.assign('vendor_contract', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'vendor_contract', id } }, tx)).number;
      await tx.update(vendorContracts).set({ status: 'active', number, approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(vendorContracts.id, id));
      await this.event(tx, ctx, id, 'approved', { data: { number } });
      return { number };
    });
  }

  async sendBack(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the contract is sent back.');
    await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx.companyId, id);
      if (c.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This contract is not waiting for approval.');
      if (c.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to decide this contract: you wrote it.');
      await tx.update(vendorContracts).set({ status: 'draft', rejectReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorContracts.id, id));
      await this.event(tx, ctx, id, 'sent_back', { reason: text.slice(0, 500) });
    });
  }

  /** Ends a contract early (no more orders); orders already called off stand. */
  async close(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the contract is closed.');
    await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx.companyId, id);
      if (c.status !== 'active') throw new FinanceError('WRONG_STATE', 'Only a contract in force can be closed.');
      await tx.update(vendorContracts).set({ status: 'closed', closeReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorContracts.id, id));
      await this.event(tx, ctx, id, 'closed', { reason: text.slice(0, 500) });
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the contract is cancelled.');
    await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx.companyId, id);
      if (c.status !== 'draft' && c.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'Only a draft or a contract waiting for approval can be cancelled. Close one that is in force.');
      await tx.update(vendorContracts).set({ status: 'cancelled', closeReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorContracts.id, id));
      await this.event(tx, ctx, id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(companyId: string, f: { status?: string; vendorId?: string } = {}, limit = 100) {
    const rows = await this.db
      .select({ c: vendorContracts, vendor: vendors.legalName })
      .from(vendorContracts)
      .innerJoin(vendors, eq(vendors.id, vendorContracts.vendorId))
      .where(and(eq(vendorContracts.companyId, companyId), has(f.status) ? eq(vendorContracts.status, f.status as 'draft') : undefined, has(f.vendorId) ? eq(vendorContracts.vendorId, f.vendorId) : undefined))
      .orderBy(desc(vendorContracts.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(({ c, vendor }) => ({ id: c.id, number: c.number, status: c.status, title: c.title, vendor, vendorId: c.vendorId, currency: c.currency, validFrom: c.validFrom, validTo: c.validTo, maxValue: c.maxValue }));
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ c: vendorContracts, vendor: vendors.legalName, category: procurementCategories.name })
      .from(vendorContracts)
      .innerJoin(vendors, eq(vendors.id, vendorContracts.vendorId))
      .innerJoin(procurementCategories, eq(procurementCategories.id, vendorContracts.categoryId))
      .where(and(eq(vendorContracts.companyId, companyId), eq(vendorContracts.id, id)));
    if (head === undefined) return null;
    const [lines, events, used] = await Promise.all([
      this.db.select().from(vendorContractLines).where(eq(vendorContractLines.contractId, id)).orderBy(asc(vendorContractLines.position)),
      this.db.select().from(vendorContractEvents).where(eq(vendorContractEvents.contractId, id)).orderBy(desc(vendorContractEvents.id)).limit(100),
      contractUsage(this.db, id),
    ]);
    const ids = [...new Set([head.c.createdBy, head.c.approvedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const { c } = head;
    return {
      contract: { id: c.id, number: c.number, status: c.status, title: c.title, vendorId: c.vendorId, categoryId: c.categoryId, currency: c.currency, validFrom: c.validFrom, validTo: c.validTo, maxValue: c.maxValue, terms: c.terms ?? '', createdBy: c.createdBy, rejectReason: c.rejectReason, closeReason: c.closeReason },
      vendor: head.vendor,
      category: head.category,
      lines: lines.map((l) => {
        const usedQty = used.perLine.get(l.id) ?? 0;
        return { id: l.id, productId: l.productId, description: l.description, specification: l.specification ?? '', unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, maxQuantity: l.maxQuantity, usedQuantity: usedQty, remaining: remainingQuantity(l.maxQuantity, usedQty) };
      }),
      usedValue: (used.valueCents / 100).toFixed(2),
      leftValue: c.maxValue === null ? null : (Math.max(0, toCents(c.maxValue) - used.valueCents) / 100).toFixed(2),
      createdName: who(c.createdBy),
      approvedName: who(c.approvedBy),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}
