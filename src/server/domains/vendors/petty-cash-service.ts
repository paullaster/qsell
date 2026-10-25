import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  financeAttachments,
  glAccounts,
  paymentMethods,
  pettyCashEvents,
  pettyCashFloats,
  pettyCashReplenishments,
  pettyCashVouchers,
  purchaseInvoices,
  users,
  vendorLedgerEntries,
  vendorPostingGroups,
  vendors,
  type PettyCashFloatRow,
  type PettyCashReplenishmentRow,
  type PettyCashVoucherRow,
  type PettyVoucherStatus,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { PETTY_LIVE, cents, checkFloatForm, checkPettyVoucher, floatLow, fmt, notEnoughCash, overDaily, overLimit, topUpAmount, type FloatForm, type PettyVoucherForm } from '@/lib/petty-cash';
import { approvalRefusal } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };

/**
 * Petty cash (design doc §12.5a): a float of cash with a custodian, a limit for one voucher and for a day, and a level it is topped
 * back up to. A voucher pays an expense with no vendor or a small vendor invoice; it needs a receipt, another person's approval
 * (never the writer's), and it cannot take the float below nothing. The cash on hand is the float's own ledger; a top-up moves money
 * from a bank account to the float and lists the vouchers it replaces.
 */
export class PettyCashService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly engine: PostingEngine,
    private readonly ledger: VendorLedgerService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, subjectType: 'float' | 'voucher' | 'replenishment', subjectId: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(pettyCashEvents).values({ companyId: ctx.companyId, subjectType, subjectId, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  private async lockVoucher(tx: Tx, companyId: string, id: string): Promise<PettyCashVoucherRow> {
    const [v] = await tx.select().from(pettyCashVouchers).where(and(eq(pettyCashVouchers.companyId, companyId), eq(pettyCashVouchers.id, id))).for('update');
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That petty cash voucher does not exist.');
    return v;
  }

  private async floatOf(tx: Tx | DrizzleDb, companyId: string, id: string): Promise<PettyCashFloatRow> {
    const [f] = await tx.select().from(pettyCashFloats).where(and(eq(pettyCashFloats.companyId, companyId), eq(pettyCashFloats.id, id)));
    if (f === undefined) throw new FinanceError('NOT_FOUND', 'That float does not exist.');
    return f;
  }

  /** The cash in the float, in cents: everything the float's own ledger shows. */
  async balanceCents(db: Tx | DrizzleDb, bankAccountId: string): Promise<number> {
    const [r] = await db.select({ total: sql<string>`COALESCE(SUM(${bankLedgerEntries.amount}), 0)::text` }).from(bankLedgerEntries).where(eq(bankLedgerEntries.bankAccountId, bankAccountId));
    return Math.round(Number(r?.total ?? '0') * 100);
  }

  private async paidOn(db: Tx | DrizzleDb, floatId: string, date: string, exceptId: string | null): Promise<number> {
    const [r] = await db
      .select({ total: sql<string>`COALESCE(SUM(${pettyCashVouchers.amount}), 0)::text` })
      .from(pettyCashVouchers)
      .where(and(eq(pettyCashVouchers.floatId, floatId), eq(pettyCashVouchers.status, 'paid'), eq(pettyCashVouchers.paidOn, date), exceptId === null ? undefined : ne(pettyCashVouchers.id, exceptId)));
    return cents(r?.total ?? '0');
  }

  private async approvedWaiting(db: Tx | DrizzleDb, floatId: string, exceptId: string | null): Promise<number> {
    const [r] = await db
      .select({ total: sql<string>`COALESCE(SUM(${pettyCashVouchers.amount}), 0)::text` })
      .from(pettyCashVouchers)
      .where(and(eq(pettyCashVouchers.floatId, floatId), eq(pettyCashVouchers.status, 'approved'), exceptId === null ? undefined : ne(pettyCashVouchers.id, exceptId)));
    return cents(r?.total ?? '0');
  }

  // ── floats ───────────────────────────────────────────────────────────────

  async saveFloat(ctx: FinanceContext, id: string | null, form: FloatForm): Promise<{ id: string }> {
    const first = Object.values(checkFloatForm(form))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    const [bank] = await this.db.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, form.bankAccountId)));
    if (bank === undefined || bank.blocked || bank.kind !== 'cash') throw new FinanceError('INVALID', 'Choose an open cash account for the float.');
    const [gl] = await this.db.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, form.glAccountId)));
    if (gl?.type !== 'posting' || gl.blocked || gl.category !== 'assets') throw new FinanceError('INVALID', 'Choose an open asset account for the cash.');
    const [who] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, form.custodianId), eq(users.status, 'active')));
    if (who === undefined) throw new FinanceError('INVALID', 'Choose an active member of staff to look after the cash.');
    const fixed = { code: form.code.trim(), name: form.name.trim(), bankAccountId: bank.id, glAccountId: gl.id, custodianId: who.id, currency: bank.currency, floatAmount: fmt(cents(form.floatAmount)), perVoucherLimit: fmt(cents(form.perVoucherLimit)), dailyLimit: fmt(cents(form.dailyLimit)), minimumBalance: fmt(cents(form.minimumBalance === '' ? '0' : form.minimumBalance)), updatedAt: new Date() };
    try {
      if (id === null) {
        const [made] = await this.db.insert(pettyCashFloats).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...fixed }).returning({ id: pettyCashFloats.id });
        const newId = made?.id ?? '';
        await this.event(this.db, ctx, 'float', newId, 'created', { data: { code: fixed.code } });
        return { id: newId };
      }
      const [row] = await this.db.update(pettyCashFloats).set(fixed).where(and(eq(pettyCashFloats.companyId, ctx.companyId), eq(pettyCashFloats.id, id))).returning({ id: pettyCashFloats.id });
      if (row === undefined) throw new FinanceError('NOT_FOUND', 'That float does not exist.');
      await this.event(this.db, ctx, 'float', row.id, 'changed');
      return { id: row.id };
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new FinanceError('DUPLICATE', 'That code, or that cash account, is already used by another float.');
      throw error;
    }
  }

  async setActive(ctx: FinanceContext, id: string, active: boolean): Promise<void> {
    const f = await this.floatOf(this.db, ctx.companyId, id);
    if (!active) {
      const [open] = await this.db.select({ n: sql<number>`count(*)::int` }).from(pettyCashVouchers).where(and(eq(pettyCashVouchers.floatId, f.id), inArray(pettyCashVouchers.status, [...PETTY_LIVE])));
      if ((open?.n ?? 0) > 0) throw new FinanceError('HAS_OPEN', 'This float still has vouchers in progress. Finish or cancel them first.');
    }
    await this.db.update(pettyCashFloats).set({ active, updatedAt: new Date() }).where(eq(pettyCashFloats.id, id));
    await this.event(this.db, ctx, 'float', id, active ? 'switched_on' : 'switched_off');
  }

  async floats(companyId: string, today: string = businessDate()) {
    const rows = await this.db
      .select({ f: pettyCashFloats, custodian: users.name })
      .from(pettyCashFloats)
      .leftJoin(users, eq(users.id, sql`${pettyCashFloats.custodianId}::uuid`))
      .where(eq(pettyCashFloats.companyId, companyId))
      .orderBy(asc(pettyCashFloats.code));
    const out = [];
    for (const r of rows) {
      const balance = await this.balanceCents(this.db, r.f.bankAccountId);
      const spentToday = await this.paidOn(this.db, r.f.id, today, null);
      const [waiting] = await this.db.select({ n: sql<number>`count(*)::int` }).from(pettyCashVouchers).where(and(eq(pettyCashVouchers.floatId, r.f.id), eq(pettyCashVouchers.status, 'paid'), isNull(pettyCashVouchers.replenishmentId)));
      out.push({ ...r.f, createdAt: r.f.createdAt.toISOString(), updatedAt: r.f.updatedAt.toISOString(), custodianName: r.custodian ?? 'Someone', balanceCents: balance, spentTodayCents: spentToday, low: floatLow(balance, cents(r.f.minimumBalance)) !== null, uncovered: waiting?.n ?? 0 });
    }
    return out;
  }

  // ── vouchers ─────────────────────────────────────────────────────────────

  async saveDraft(ctx: FinanceContext, id: string | null, form: PettyVoucherForm): Promise<{ id: string }> {
    const first = Object.values(checkPettyVoucher(form))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    return await this.db.transaction(async (tx) => {
      const f = await this.floatOf(tx, ctx.companyId, form.floatId);
      if (!f.active) throw new FinanceError('FLOAT_OFF', 'This float is switched off.');
      const amount = cents(form.amount);
      const tooBig = overLimit(amount, cents(f.perVoucherLimit));
      if (tooBig !== null) throw new FinanceError('OVER_LIMIT', tooBig);
      const low = floatLow(await this.balanceCents(tx, f.bankAccountId), cents(f.minimumBalance));
      if (low !== null && id === null) throw new FinanceError('FLOAT_LOW', low);
      let vendorId: string | null = null;
      let invoiceId: string | null = null;
      let accountId: string | null = null;
      if (form.kind === 'vendor_invoice') {
        const [inv] = await tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.companyId, ctx.companyId), eq(purchaseInvoices.id, form.purchaseInvoiceId)));
        if (inv === undefined) throw new FinanceError('NOT_FOUND', 'That vendor invoice does not exist.');
        const [entry] = await tx.select({ remaining: vendorLedgerEntries.remainingAmount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, inv.ledgerEntryId));
        if (amount > cents(entry?.remaining ?? '0')) throw new FinanceError('INVALID', `Only ${entry?.remaining ?? '0.00'} is open on that invoice.`);
        if (inv.currency !== f.currency) throw new FinanceError('CURRENCY', 'The invoice is in another currency than the float.');
        vendorId = inv.vendorId;
        invoiceId = inv.id;
      } else {
        const [acc] = await tx.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, form.expenseAccountId)));
        if (acc?.type !== 'posting' || acc.blocked || acc.postingSource !== 'manual' || !['expense', 'cost_of_sales'].includes(acc.category ?? '')) throw new FinanceError('INVALID', 'Choose an open expense account.');
        accountId = acc.id;
      }
      const values = { floatId: f.id, kind: form.kind, payeeName: form.payeeName.trim(), vendorId, purchaseInvoiceId: invoiceId, expenseAccountId: accountId, description: form.description.trim(), receiptRef: form.receiptRef.trim(), amount: fmt(amount), currency: f.currency, updatedAt: new Date() };
      if (id === null) {
        const [made] = await tx.insert(pettyCashVouchers).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...values }).returning({ id: pettyCashVouchers.id });
        const newId = made?.id ?? '';
        await this.event(tx, ctx, 'voucher', newId, 'created', { data: { amount: values.amount, kind: form.kind } });
        return { id: newId };
      }
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed. Ask for it to be sent back first.');
      await tx.update(pettyCashVouchers).set(values).where(eq(pettyCashVouchers.id, id));
      return { id };
    });
  }

  async attachmentCount(db: Tx | DrizzleDb, id: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(financeAttachments).where(and(eq(financeAttachments.subjectType, 'petty_cash_voucher'), eq(financeAttachments.subjectId, id)));
    return r?.n ?? 0;
  }

  async attach(ctx: FinanceContext, id: string, file: { mediaAssetId: string; fileName: string; note?: string | null }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status === 'cancelled' || v.status === 'reversed') throw new FinanceError('NOT_ACTIVE', `This voucher is ${v.status}.`);
      await tx.insert(financeAttachments).values({ companyId: ctx.companyId, subjectType: 'petty_cash_voucher', subjectId: id, mediaAssetId: file.mediaAssetId, fileName: file.fileName, note: file.note ?? null, uploadedBy: ctx.actor.id ?? 'unknown' });
      await this.event(tx, ctx, 'voucher', id, 'receipt_added', { data: { fileName: file.fileName } });
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be sent for approval.');
      if ((await this.attachmentCount(tx, id)) === 0) throw new FinanceError('RECEIPT_REQUIRED', 'Attach a picture of the receipt first.');
      const f = await this.floatOf(tx, ctx.companyId, v.floatId);
      const low = floatLow(await this.balanceCents(tx, f.bankAccountId), cents(f.minimumBalance));
      if (low !== null) throw new FinanceError('FLOAT_LOW', low);
      await tx.update(pettyCashVouchers).set({ status: 'pending_approval', submittedAt: now, sendBackReason: null, updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'submitted');
    });
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This voucher is not waiting for approval.');
      const refusal = approvalRefusal(ctx.actor.id ?? '', v.createdBy);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', refusal.replace('payment', 'voucher'));
      const f = await this.floatOf(tx, ctx.companyId, v.floatId);
      const amount = cents(v.amount);
      const today = businessDate(now);
      const daily = overDaily((await this.paidOn(tx, f.id, today, null)) + (await this.approvedWaiting(tx, f.id, id)), amount, cents(f.dailyLimit));
      if (daily !== null) throw new FinanceError('OVER_DAILY', daily);
      const number = v.number ?? (await this.numbering.assign('petty_cash_voucher', { companyId: ctx.companyId, branchId: null, date: today, document: { kind: 'petty_cash_voucher', id } }, tx)).number;
      await tx.update(pettyCashVouchers).set({ status: 'approved', number, approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'approved', { data: { number } });
      return { number };
    });
  }

  async sendBack(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the voucher is sent back.');
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This voucher is not waiting for approval.');
      await tx.update(pettyCashVouchers).set({ status: 'draft', sendBackReason: text.slice(0, 500), updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'sent_back', { reason: text.slice(0, 500) });
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the voucher is cancelled.');
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (!(PETTY_LIVE as readonly string[]).includes(v.status)) throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'A paid voucher cannot be cancelled. Reverse it.' : 'This voucher is finished.');
      await tx.update(pettyCashVouchers).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  /** The cash is handed over: booked, taken off the float, and (for a vendor invoice) set against the invoice. */
  async pay(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    return await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'approved') throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'This voucher has already been paid.' : 'Only an approved voucher can be paid.');
      const f = await this.floatOf(tx, ctx.companyId, v.floatId);
      if (!f.active) throw new FinanceError('FLOAT_OFF', 'This float is switched off.');
      const amount = cents(v.amount);
      const today = businessDate(now);
      const cash = notEnoughCash(await this.balanceCents(tx, f.bankAccountId), amount);
      if (cash !== null) throw new FinanceError('NOT_ENOUGH_CASH', cash);
      const daily = overDaily(await this.paidOn(tx, f.id, today, id), amount, cents(f.dailyLimit));
      if (daily !== null) throw new FinanceError('OVER_DAILY', daily);
      let debitAccount = v.expenseAccountId;
      let sourceVendor: string | null = null;
      let inv: typeof purchaseInvoices.$inferSelect | undefined;
      if (v.kind === 'vendor_invoice') {
        [inv] = await tx.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, v.purchaseInvoiceId ?? ''));
        const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, v.vendorId ?? ''));
        if (inv === undefined || vendor === undefined) throw new FinanceError('NOT_FOUND', 'The vendor invoice is missing.');
        if (vendor.block !== 'none') throw new FinanceError('VENDOR_BLOCKED', `${vendor.legalName} is blocked from payments.`);
        if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group.`);
        const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
        debitAccount = group?.payablesAccountId ?? null;
        sourceVendor = vendor.id;
      }
      if (debitAccount === null) throw new FinanceError('POSTING_GROUP', 'No account to book this payment to.');
      const description = `Petty cash ${v.number ?? ''}: ${v.payeeName}, ${v.description}`.slice(0, 200);
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `petty-cash:${id}`,
          postingDate: today,
          documentType: 'petty_cash_payment',
          documentNo: v.number ?? '',
          description,
          currency: v.currency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: debitAccount, debit: v.amount, credit: '0', description, ...(sourceVendor === null ? {} : { sourceLedger: 'vendor', sourceEntryId: sourceVendor }) },
            { accountId: f.glAccountId, debit: '0', credit: v.amount, description, sourceLedger: 'bank', sourceEntryId: f.bankAccountId },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'petty_cash_voucher', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      const [bankEntry] = await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: f.bankAccountId, glAccountId: f.glAccountId, postingDate: today, documentType: 'petty_cash', documentNo: v.number ?? '', documentId: id, description, amount: fmt(-amount), currency: v.currency, registerId, createdBy: ctx.actor.id }).returning({ id: bankLedgerEntries.id });
      let ledgerEntryId: string | null = null;
      if (inv !== undefined && sourceVendor !== null) {
        ledgerEntryId = randomUUID();
        await this.ledger.addEntry(tx, { id: ledgerEntryId, companyId: ctx.companyId, vendorId: sourceVendor, documentType: 'payment', documentNo: v.number ?? '', documentId: id, description, amountCents: -amount, currency: v.currency, postingDate: today, registerId, idempotencyKey: `petty-cash:${id}`, createdBy: ctx.actor.id });
        await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: sourceVendor, creditEntryId: ledgerEntryId, invoiceEntryId: inv.ledgerEntryId, amountCents: amount, postingDate: today, registerId, createdBy: ctx.actor.id });
      }
      await tx.update(pettyCashVouchers).set({ status: 'paid', paidBy: ctx.actor.id, paidAt: now, paidOn: today, registerId, bankLedgerEntryId: bankEntry?.id ?? null, ledgerEntryId, updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'paid', { data: { registerId } });
      return { number: v.number ?? '', registerId };
    });
  }

  async reverse(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is reversed.');
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, ctx.companyId, id);
      if (v.status !== 'paid' || v.registerId === null) throw new FinanceError('NOT_PAID', 'Only a paid voucher can be reversed.');
      if (v.replenishmentId !== null) throw new FinanceError('COVERED', 'This payment has already been covered by a top-up of the float. Record the cash coming back another way.');
      const today = businessDate(now);
      if (v.ledgerEntryId !== null) {
        await this.ledger.unapplyAll(tx, { companyId: ctx.companyId, entryId: v.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), createdBy: ctx.actor.id });
      }
      const reversal = await this.engine.reverse({ companyId: ctx.companyId, registerId: v.registerId, postingDate: today, reasonCode: 'petty_cash_reversed', reasonText: text.slice(0, 500), origin: ctx.origin, permissions: ENGINE, tx });
      if (v.ledgerEntryId !== null) await this.ledger.reverseEntry(tx, { companyId: ctx.companyId, entryId: v.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), registerId: reversal.registerId, createdBy: ctx.actor.id });
      const [orig] = await tx.select().from(bankLedgerEntries).where(eq(bankLedgerEntries.id, v.bankLedgerEntryId ?? -1));
      if (orig !== undefined) {
        await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: orig.bankAccountId, glAccountId: orig.glAccountId, postingDate: today, documentType: 'petty_cash_reversal', documentNo: orig.documentNo, documentId: id, description: `Reversed: ${orig.description ?? ''}`.slice(0, 200), amount: fmt(-cents(orig.amount)), currency: orig.currency, registerId: reversal.registerId, reversesEntryId: orig.id, createdBy: ctx.actor.id });
      }
      await tx.update(pettyCashVouchers).set({ status: 'reversed', reversedBy: ctx.actor.id, reversedAt: now, reverseReason: text.slice(0, 500), reversalRegisterId: reversal.registerId, updatedAt: now }).where(eq(pettyCashVouchers.id, id));
      await this.event(tx, ctx, 'voucher', id, 'reversed', { reason: text.slice(0, 500) });
    });
  }

  // ── topping the float up ─────────────────────────────────────────────────

  async requestReplenishment(ctx: FinanceContext, input: { floatId: string; fromMethodId: string; amount: string; countNote: string }, now: Date = new Date()): Promise<{ id: string; number: string; amount: string }> {
    return await this.db.transaction(async (tx) => {
      const f = await this.floatOf(tx, ctx.companyId, input.floatId);
      const [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.fromMethodId)));
      if (m === undefined || !m.enabled || m.balancingBankAccountId === f.bankAccountId) throw new FinanceError('INVALID', 'Choose the way of paying that the money comes from. It cannot be the float itself.');
      const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, m.balancingBankAccountId));
      if (bank === undefined || bank.blocked || bank.currency !== f.currency) throw new FinanceError('INVALID', 'The bank account behind that way of paying cannot be used.');
      const [waiting] = await tx.select({ total: sql<string>`COALESCE(SUM(${pettyCashReplenishments.amount}), 0)::text` }).from(pettyCashReplenishments).where(and(eq(pettyCashReplenishments.floatId, f.id), inArray(pettyCashReplenishments.status, ['pending_approval', 'approved'])));
      const room = topUpAmount(cents(f.floatAmount), (await this.balanceCents(tx, f.bankAccountId)) + cents(waiting?.total ?? '0'));
      if (room <= 0) throw new FinanceError('FULL', 'The float is already full, counting top-ups that are waiting.');
      const asked = input.amount.trim() === '' ? room : cents(input.amount);
      if (!/^\d+(\.\d{1,2})?$/.test((input.amount.trim() === '' ? fmt(room) : input.amount).trim()) || asked <= 0) throw new FinanceError('INVALID', 'Enter the amount to top up with, above zero.');
      if (asked > room) throw new FinanceError('TOO_MUCH', `Only ${fmt(room)} is needed to bring the float back to ${f.floatAmount}.`);
      const id = randomUUID();
      const { number } = await this.numbering.assign('petty_cash_replenishment', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'petty_cash_replenishment', id } }, tx);
      await tx.insert(pettyCashReplenishments).values({ id, companyId: ctx.companyId, floatId: f.id, number, amount: fmt(asked), fromMethodId: m.id, countNote: trimToNull(input.countNote), createdBy: ctx.actor.id });
      const covered = await tx.update(pettyCashVouchers).set({ replenishmentId: id }).where(and(eq(pettyCashVouchers.floatId, f.id), eq(pettyCashVouchers.status, 'paid'), isNull(pettyCashVouchers.replenishmentId))).returning({ id: pettyCashVouchers.id });
      await this.event(tx, ctx, 'replenishment', id, 'requested', { data: { amount: fmt(asked), vouchers: covered.length } });
      return { id, number, amount: fmt(asked) };
    });
  }

  async approveReplenishment(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(pettyCashReplenishments).where(and(eq(pettyCashReplenishments.companyId, ctx.companyId), eq(pettyCashReplenishments.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That top-up does not exist.');
      if (r.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This top-up is not waiting for approval.');
      const refusal = approvalRefusal(ctx.actor.id ?? '', r.createdBy);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', refusal.replace('payment', 'top-up'));
      await tx.update(pettyCashReplenishments).set({ status: 'approved', approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(pettyCashReplenishments.id, id));
      await this.event(tx, ctx, 'replenishment', id, 'approved');
    });
  }

  /** The money moves from the bank account to the float; the reference is the transfer or withdrawal slip. */
  async payReplenishment(ctx: FinanceContext, id: string, input: { reference: string }, now: Date = new Date()): Promise<{ registerId: string }> {
    const reference = trimToNull(input.reference);
    if (!has(reference)) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the reference of the transfer or withdrawal.');
    return await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(pettyCashReplenishments).where(and(eq(pettyCashReplenishments.companyId, ctx.companyId), eq(pettyCashReplenishments.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That top-up does not exist.');
      if (r.status !== 'approved') throw new FinanceError('WRONG_STATE', 'Only an approved top-up can be paid.');
      const f = await this.floatOf(tx, ctx.companyId, r.floatId);
      const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, r.fromMethodId));
      if (m === undefined) throw new FinanceError('NOT_FOUND', 'The way of paying is missing.');
      const today = businessDate(now);
      const description = `Petty cash top-up ${r.number} ${reference}`;
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `petty-cash-top-up:${id}`,
          postingDate: today,
          documentType: 'petty_cash_replenishment',
          documentNo: r.number,
          description,
          currency: f.currency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: f.glAccountId, debit: r.amount, credit: '0', description, sourceLedger: 'bank', sourceEntryId: f.bankAccountId },
            { accountId: m.glAccountId, debit: '0', credit: r.amount, description, sourceLedger: 'bank', sourceEntryId: m.balancingBankAccountId },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'petty_cash_replenishment', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      await tx.insert(bankLedgerEntries).values([
        { companyId: ctx.companyId, bankAccountId: m.balancingBankAccountId, glAccountId: m.glAccountId, postingDate: today, documentType: 'petty_cash_replenishment', documentNo: r.number, documentId: id, description, amount: fmt(-cents(r.amount)), currency: f.currency, registerId, createdBy: ctx.actor.id },
        { companyId: ctx.companyId, bankAccountId: f.bankAccountId, glAccountId: f.glAccountId, postingDate: today, documentType: 'petty_cash_replenishment', documentNo: r.number, documentId: id, description, amount: r.amount, currency: f.currency, registerId, createdBy: ctx.actor.id },
      ]);
      await tx.update(pettyCashReplenishments).set({ status: 'paid', paidBy: ctx.actor.id, paidAt: now, paidOn: today, reference: reference.slice(0, 120), registerId, updatedAt: now }).where(eq(pettyCashReplenishments.id, id));
      await this.event(tx, ctx, 'replenishment', id, 'paid', { data: { reference, registerId } });
      return { registerId };
    });
  }

  async cancelReplenishment(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the top-up is cancelled.');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(pettyCashReplenishments).where(and(eq(pettyCashReplenishments.companyId, ctx.companyId), eq(pettyCashReplenishments.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That top-up does not exist.');
      if (r.status === 'paid' || r.status === 'cancelled') throw new FinanceError('WRONG_STATE', 'This top-up is finished.');
      await tx.update(pettyCashReplenishments).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: now }).where(eq(pettyCashReplenishments.id, id));
      await tx.update(pettyCashVouchers).set({ replenishmentId: null }).where(eq(pettyCashVouchers.replenishmentId, id));
      await this.event(tx, ctx, 'replenishment', id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const clean = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    if (clean.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, clean));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async floatDetail(companyId: string, id: string) {
    const [f] = (await this.floats(companyId)).filter((x) => x.id === id);
    if (f === undefined) return null;
    const [vouchers, replenishments] = await Promise.all([
      this.db.select().from(pettyCashVouchers).where(eq(pettyCashVouchers.floatId, id)).orderBy(desc(pettyCashVouchers.createdAt)).limit(100),
      this.db.select().from(pettyCashReplenishments).where(eq(pettyCashReplenishments.floatId, id)).orderBy(desc(pettyCashReplenishments.createdAt)).limit(50),
    ]);
    const names = await this.names(replenishments.flatMap((r) => [r.createdBy, r.approvedBy]));
    return {
      float: f,
      vouchers: vouchers.map((v) => ({ id: v.id, number: v.number, status: v.status, kind: v.kind, payeeName: v.payeeName, description: v.description, amount: v.amount, createdAt: v.createdAt.toISOString(), covered: v.replenishmentId !== null })),
      replenishments: replenishments.map((r) => ({ id: r.id, number: r.number, status: r.status, amount: r.amount, createdAt: r.createdAt.toISOString(), createdName: r.createdBy === null ? null : (names.get(r.createdBy) ?? 'Someone'), approvedName: r.approvedBy === null ? null : (names.get(r.approvedBy) ?? 'Someone'), reference: r.reference, countNote: r.countNote })),
    };
  }

  async voucherDetail(companyId: string, id: string) {
    const [head] = await this.db.select({ v: pettyCashVouchers, floatName: pettyCashFloats.name }).from(pettyCashVouchers).innerJoin(pettyCashFloats, eq(pettyCashFloats.id, pettyCashVouchers.floatId)).where(and(eq(pettyCashVouchers.companyId, companyId), eq(pettyCashVouchers.id, id)));
    if (head === undefined) return null;
    const v = head.v;
    const [events, attachments] = await Promise.all([
      this.db.select().from(pettyCashEvents).where(and(eq(pettyCashEvents.subjectType, 'voucher'), eq(pettyCashEvents.subjectId, id))).orderBy(desc(pettyCashEvents.id)).limit(100),
      this.db.select().from(financeAttachments).where(and(eq(financeAttachments.subjectType, 'petty_cash_voucher'), eq(financeAttachments.subjectId, id))).orderBy(asc(financeAttachments.createdAt)),
    ]);
    const names = await this.names([v.createdBy, v.approvedBy, v.paidBy, ...events.map((e) => e.actorId)]);
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    return {
      voucher: { ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(), submittedAt: v.submittedAt?.toISOString() ?? null, approvedAt: v.approvedAt?.toISOString() ?? null, paidAt: v.paidAt?.toISOString() ?? null, reversedAt: v.reversedAt?.toISOString() ?? null },
      floatName: head.floatName,
      createdName: who(v.createdBy),
      approvedName: who(v.approvedBy),
      paidName: who(v.paidBy),
      attachments: attachments.map((a) => ({ id: a.id, mediaAssetId: a.mediaAssetId, fileName: a.fileName, note: a.note, createdAt: a.createdAt.toISOString() })),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }

  async list(companyId: string, f: { floatId?: string; status?: PettyVoucherStatus }, limit = 100) {
    return await this.db
      .select({ v: pettyCashVouchers, floatName: pettyCashFloats.name })
      .from(pettyCashVouchers)
      .innerJoin(pettyCashFloats, eq(pettyCashFloats.id, pettyCashVouchers.floatId))
      .where(and(eq(pettyCashVouchers.companyId, companyId), has(f.floatId) ? eq(pettyCashVouchers.floatId, f.floatId) : undefined, has(f.status) ? eq(pettyCashVouchers.status, f.status) : undefined))
      .orderBy(desc(pettyCashVouchers.createdAt))
      .limit(Math.min(limit, 200));
  }
}

export type { PettyCashReplenishmentRow };
