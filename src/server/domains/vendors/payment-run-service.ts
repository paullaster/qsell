import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  companySettings,
  users,
  vendorBankAccounts,
  vendorPaymentBatchEvents,
  vendorPaymentBatches,
  vendorPaymentVoucherLines,
  vendorPaymentVouchers,
  vendors,
  type VendorBatchStatus,
  type VendorPaymentBatchRow,
  type VendorPaymentVoucherRow,
} from '@/server/db/drizzle/schema';
import { has, orElse, trimToNull } from '@/lib/values';
import { fromCents, releaseRefusal, toCents, type AllocationForm } from '@/lib/vendor-payment';
import { MAX_RUN_LINES, applyLimits, buildChequeSchedule, chequeNumbers, confirmRefusal, type ChequeLine } from '@/lib/vendor-payment-run';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { EncryptedCredentialsBlob } from '@/server/domains/payments/types';
import { buildCsv, buildPain001, type FileLine } from '@/server/domains/finance/domain/refund-file';
import type { PaidResult, VendorPaymentService } from './payment-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor {
  type: 'user' | 'system' | 'job' | 'integration';
  id: string | null;
}
const LATEST_DAYS_AHEAD = 30;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface RunSelection {
  vendorId: string;
  allocations: AllocationForm[];
}

/**
 * Payment runs (design doc §12.6): what is due is suggested, the chosen vendors become one draft voucher each in a run, the run
 * is approved as one (all, some or none of its vouchers), released as a bank file or a cheque run, and confirmed when paid: every
 * voucher in it is then paid together, or none is. The bank file carries account numbers, so it is never stored: it is rebuilt
 * on download and checked against the fingerprint taken when it was made.
 */
export class PaymentRunService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly payments: VendorPaymentService,
    private readonly openBankNumber: (blob: EncryptedCredentialsBlob) => string,
  ) {}

  private async event(tx: Tx | DrizzleDb, actor: Actor, batchId: string, event: string, from: string | null, to: string | null, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorPaymentBatchEvents).values({ batchId, event, fromStatus: from, toStatus: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<VendorPaymentBatchRow> {
    const [b] = await tx.select().from(vendorPaymentBatches).where(and(eq(vendorPaymentBatches.companyId, companyId), eq(vendorPaymentBatches.id, id))).for('update');
    if (b === undefined) throw new FinanceError('NOT_FOUND', 'That payment run does not exist.');
    return b;
  }

  private async vouchersOf(tx: Tx | DrizzleDb, batchId: string): Promise<VendorPaymentVoucherRow[]> {
    return await tx.select().from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.batchId, batchId)).orderBy(asc(vendorPaymentVouchers.number), asc(vendorPaymentVouchers.createdAt), asc(vendorPaymentVouchers.id));
  }

  // ── the proposal ─────────────────────────────────────────────────────────

  /** What could be paid by `dueOn`, grouped by vendor, and who was left out and why (design doc §12.6). */
  async suggest(companyId: string, f: { methodId: string; dueOn: string; vendorId?: string; minCents?: number | null; maxCents?: number | null }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dueOn)) throw new FinanceError('DATE_INVALID', 'Choose the date to pay invoices due up to.');
    const method = await this.payments.methodForRun(companyId, f.methodId);
    const items = await this.payments.dueItems(companyId, { dueOn: f.dueOn, vendorId: f.vendorId });
    const vendorIds = [...new Set(items.map((i) => i.vendorId))];
    const withAccount = new Set(
      !method.needsAccount || vendorIds.length === 0
        ? []
        : (await this.db.select({ vendorId: vendorBankAccounts.vendorId }).from(vendorBankAccounts).where(and(inArray(vendorBankAccounts.vendorId, vendorIds), eq(vendorBankAccounts.status, 'active')))).map((r) => r.vendorId),
    );
    const excluded: { vendorId: string; vendorName: string; reason: string }[] = [];
    const byVendor = new Map<string, { vendorId: string; vendorName: string; items: typeof items }>();
    for (const i of items) {
      if (i.block !== 'none') {
        if (!excluded.some((e) => e.vendorId === i.vendorId)) excluded.push({ vendorId: i.vendorId, vendorName: i.vendorName, reason: 'Blocked from payments.' });
        continue;
      }
      if (method.needsAccount && !withAccount.has(i.vendorId)) {
        if (!excluded.some((e) => e.vendorId === i.vendorId)) excluded.push({ vendorId: i.vendorId, vendorName: i.vendorName, reason: 'No bank account that can receive money (none, or a change is waiting).' });
        continue;
      }
      const entry = byVendor.get(i.vendorId) ?? { vendorId: i.vendorId, vendorName: i.vendorName, items: [] };
      entry.items.push(i);
      byVendor.set(i.vendorId, entry);
    }
    const limited = applyLimits([...byVendor.values()].map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, items: v.items.map((i) => ({ purchaseInvoiceId: i.purchaseInvoiceId, availableCents: i.availableCents })) })), f.minCents ?? null, f.maxCents ?? null);
    const keptIds = new Set(limited.kept.map((k) => k.vendorId));
    return {
      method: { id: method.id, name: method.name, kind: method.kind },
      vendors: [...byVendor.values()].filter((v) => keptIds.has(v.vendorId)).map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, totalCents: v.items.reduce((n, i) => n + i.availableCents, 0), items: v.items })),
      excluded: [...excluded, ...limited.left],
    };
  }

  // ── making and moving a run ──────────────────────────────────────────────

  async create(ctx: FinanceContext, input: { methodId: string; executionDate: string; note: string; selections: RunSelection[] }, now: Date = new Date()): Promise<{ id: string; number: string; count: number; total: string }> {
    const today = businessDate(now);
    const latest = new Date(Date.parse(`${today}T00:00:00Z`) + LATEST_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executionDate) || input.executionDate < today || input.executionDate > latest) throw new FinanceError('DATE_INVALID', `Choose a payment date from today up to ${String(LATEST_DAYS_AHEAD)} days ahead.`);
    const picks = input.selections.filter((s) => s.allocations.length > 0);
    if (picks.length === 0) throw new FinanceError('NOTHING_TO_PAY', 'Choose at least one vendor to pay.');
    if (picks.length > MAX_RUN_LINES) throw new FinanceError('TOO_MANY', `A run holds at most ${String(MAX_RUN_LINES)} vendors.`);
    if (new Set(picks.map((p) => p.vendorId)).size !== picks.length) throw new FinanceError('INVALID', 'Each vendor can be in a run once.');
    const method = await this.payments.methodForRun(ctx.companyId, input.methodId);
    return await this.db.transaction(async (tx) => {
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('vendor_payment_batch', { companyId: ctx.companyId, branchId: null, date: today, document: { kind: 'vendor_payment_batch', id } }, tx);
      await tx.insert(vendorPaymentBatches).values({ id, companyId: ctx.companyId, number, methodId: method.id, currency: method.currency, executionDate: input.executionDate, note: trimToNull(input.note), createdBy: ctx.actor.id });
      let totalCents = 0;
      for (const p of picks) {
        const made = await this.payments.saveDraft(ctx, null, { kind: 'invoices', vendorId: p.vendorId, methodId: method.id, narration: `Payment run ${number}`, advanceId: '' }, p.allocations, { tx, batchId: id });
        totalCents += toCents(made.cash);
      }
      await tx.update(vendorPaymentBatches).set({ total: fromCents(totalCents), itemCount: picks.length }).where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'created', null, 'draft', { data: { vouchers: picks.length, total: fromCents(totalCents) } });
      return { id, number, count: picks.length, total: fromCents(totalCents) };
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status !== 'draft') throw new FinanceError('WRONG_STATE', 'Only a draft run can be sent for approval.');
      for (const v of await this.vouchersOf(tx, id)) await this.payments.submit(ctx, v.id, now, tx);
      await tx.update(vendorPaymentBatches).set({ status: 'pending_approval', submittedAt: now, updatedAt: now }).where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'submitted', 'draft', 'pending_approval');
    });
  }

  /**
   * One decision for the whole run: the vouchers named are approved (each by someone who did not prepare it); every other one is
   * sent back with the reason and taken out of the run. If none is approved the run ends.
   */
  async approve(ctx: FinanceContext, id: string, input: { approveIds: string[]; sendBackReason: string }, now: Date = new Date()): Promise<{ approved: number; sentBack: number }> {
    return await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This run is not waiting for approval.');
      const vouchers = await this.vouchersOf(tx, id);
      const yes = new Set(input.approveIds);
      if ([...yes].some((x) => !vouchers.some((v) => v.id === x))) throw new FinanceError('INVALID', 'One of those vouchers is not in this run.');
      const rest = vouchers.filter((v) => !yes.has(v.id));
      const reason = trimToNull(input.sendBackReason);
      if (rest.length > 0 && !has(reason)) throw new FinanceError('NOTE_REQUIRED', 'Say why the vouchers you are leaving out are sent back.');
      for (const v of vouchers.filter((x) => yes.has(x.id))) await this.payments.approve(ctx, v.id, now, tx);
      for (const v of rest) {
        await this.payments.sendBack(ctx, v.id, reason ?? '', now, tx);
        await tx.update(vendorPaymentVouchers).set({ batchId: null }).where(eq(vendorPaymentVouchers.id, v.id));
      }
      const kept = vouchers.filter((v) => yes.has(v.id));
      const totalCents = kept.reduce((n, v) => n + toCents(v.cashAmount), 0);
      if (kept.length === 0) {
        await tx.update(vendorPaymentBatches).set({ status: 'cancelled', cancelReason: 'No voucher was approved.', cancelledBy: ctx.actor.id, cancelledAt: now, total: '0', itemCount: 0, updatedAt: now }).where(eq(vendorPaymentBatches.id, id));
        await this.event(tx, ctx.actor, id, 'cancelled', 'pending_approval', 'cancelled', { reason: reason ?? 'No voucher was approved.' });
      } else {
        const [fresh] = await tx.select({ total: sql<string>`COALESCE(SUM(${vendorPaymentVouchers.cashAmount}), 0)::text` }).from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.batchId, id));
        await tx.update(vendorPaymentBatches).set({ status: 'approved', approvedBy: ctx.actor.id, approvedAt: now, total: fresh?.total ?? fromCents(totalCents), itemCount: kept.length, updatedAt: now }).where(eq(vendorPaymentBatches.id, id));
        await this.event(tx, ctx.actor, id, 'approved', 'pending_approval', 'approved', { reason, data: { approved: kept.length, sentBack: rest.length } });
      }
      return { approved: kept.length, sentBack: rest.length };
    });
  }

  /** What the run produces depends on the way of paying: a bank file, a cheque list, or nothing (cash, paid by hand). */
  async release(ctx: FinanceContext, id: string, input: { format?: string; firstChequeNo?: string }, now: Date = new Date()): Promise<{ format: string; count: number }> {
    return await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status !== 'approved') throw new FinanceError('WRONG_STATE', 'Only an approved run can be released.');
      const method = await this.payments.methodForRun(ctx.companyId, b.methodId);
      const vouchers = await this.vouchersOf(tx, id);
      if (vouchers.length === 0) throw new FinanceError('NOTHING_TO_PAY', 'This run has no vouchers.');
      for (const v of vouchers) {
        const refusal = releaseRefusal(ctx.actor.id ?? '', v.createdBy, v.approvedBy, v.needsThree);
        if (refusal !== null) throw new FinanceError('THREE_PEOPLE', `${v.number ?? 'A voucher'}: ${refusal}`);
      }
      let format: 'csv' | 'pain001' | 'cheque' | 'none' = 'none';
      let content: string | null = null;
      let firstCheque: string | null = null;
      if (method.kind === 'bank_transfer') {
        const wanted: string = input.format ?? '';
        if (wanted !== 'csv' && wanted !== 'pain001') throw new FinanceError('FORMAT_INVALID', 'Choose a file format for the bank.');
        format = wanted;
        content = await this.bankFile(tx, b, vouchers, method, format, now);
      } else if (method.kind === 'cheque') {
        const numbers = chequeNumbers(input.firstChequeNo ?? '', vouchers.length);
        if (numbers === null) throw new FinanceError('CHEQUE_NUMBER', 'Enter the number of the first cheque to write, using digits only.');
        format = 'cheque';
        firstCheque = numbers[0] ?? null;
        for (const [i, v] of vouchers.entries()) await tx.update(vendorPaymentVouchers).set({ chequeNo: numbers[i] }).where(eq(vendorPaymentVouchers.id, v.id));
        content = await this.chequeList(tx, b, vouchers.map((v, i) => ({ ...v, chequeNo: numbers[i] ?? null })), now);
      }
      await tx
        .update(vendorPaymentBatches)
        .set({ status: 'released', releasedBy: ctx.actor.id, releasedAt: now, format, firstChequeNo: firstCheque, contentSha256: content === null ? null : sha256(content), fileCreatedAt: content === null ? null : now, updatedAt: now })
        .where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'released', 'approved', 'released', { data: { format, count: vouchers.length, firstCheque } });
      return { format, count: vouchers.length };
    }).catch((error: unknown) => {
      if ((error as { code?: string; cause?: { code?: string } }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new FinanceError('CHEQUE_NUMBER_USED', 'One of those cheque numbers is already used on this way of paying. Start from a higher number.');
      }
      throw error;
    });
  }

  private async company(tx: Tx | DrizzleDb, companyId: string): Promise<string> {
    const [c] = await tx.select({ name: companySettings.tradingName }).from(companySettings).where(eq(companySettings.id, companyId));
    return orElse(c?.name, 'Company');
  }

  private async bankFile(tx: Tx | DrizzleDb, b: VendorPaymentBatchRow, vouchers: VendorPaymentVoucherRow[], method: { debtorAccount: string; currency: string }, format: 'csv' | 'pain001', createdAt: Date): Promise<string> {
    if (format === 'pain001' && method.debtorAccount === '') throw new FinanceError('BANK_ACCOUNT_NUMBER_MISSING', 'The bank account behind this way of paying has no account number on record. Add it before making an ISO 20022 file.');
    const accountIds = vouchers.map((v) => v.vendorBankAccountId).filter((x): x is string => x !== null);
    if (accountIds.length !== vouchers.length) throw new FinanceError('NO_BANK_ACCOUNT', 'A voucher in this run has no bank account fixed on it.');
    const accounts = await tx.select().from(vendorBankAccounts).where(inArray(vendorBankAccounts.id, accountIds));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const lines: FileLine[] = vouchers.map((v) => {
      const a = byId.get(v.vendorBankAccountId ?? '');
      if (a === undefined) throw new FinanceError('NO_BANK_ACCOUNT', 'A bank account fixed on a voucher no longer exists.');
      return { endToEndId: v.number ?? '', amountCents: toCents(v.cashAmount), beneficiary: { name: a.accountName, bank: a.bankName, account: this.openBankNumber(a.accountSealed) }, narrative: `Payment ${v.number ?? ''}` };
    });
    if (format === 'csv') return buildCsv(lines, b.currency);
    return buildPain001({ messageId: b.number ?? '', createdAt, executionDate: b.executionDate, debtor: { name: await this.company(tx, b.companyId), account: method.debtorAccount }, currency: b.currency, lines });
  }

  private async chequeList(tx: Tx | DrizzleDb, b: VendorPaymentBatchRow, vouchers: (VendorPaymentVoucherRow & { chequeNo: string | null })[], _now: Date): Promise<string> {
    const names = await tx.select({ id: vendors.id, name: vendors.legalName }).from(vendors).where(inArray(vendors.id, [...new Set(vouchers.map((v) => v.vendorId))]));
    const name = new Map(names.map((n) => [n.id, n.name]));
    const lines: ChequeLine[] = vouchers.map((v) => ({ chequeNo: v.chequeNo ?? '', payee: name.get(v.vendorId) ?? '', amountCents: toCents(v.cashAmount), voucherNo: v.number ?? '' }));
    return buildChequeSchedule(lines, b.currency, b.executionDate);
  }

  /** The file or cheque list, rebuilt and checked against the fingerprint taken when the run was released. Every download is counted. */
  async download(ctx: FinanceContext, id: string): Promise<{ fileName: string; mime: string; content: string; sha256: string }> {
    return await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status !== 'released' || b.format === null || b.format === 'none' || b.contentSha256 === null || b.fileCreatedAt === null) throw new FinanceError('NO_FILE', 'This run has no file to download. It is released and not yet confirmed only when it has one.');
      const method = await this.payments.methodForRun(ctx.companyId, b.methodId);
      const vouchers = await this.vouchersOf(tx, id);
      const content = b.format === 'cheque' ? await this.chequeList(tx, b, vouchers, b.fileCreatedAt) : await this.bankFile(tx, b, vouchers, method, b.format, b.fileCreatedAt);
      if (sha256(content) !== b.contentSha256) throw new FinanceError('FILE_ALTERED', 'The file no longer matches the fingerprint taken when the run was released. Do not send it; tell an administrator.');
      await tx.update(vendorPaymentBatches).set({ downloads: b.downloads + 1 }).where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'downloaded', null, null, { data: { format: b.format } });
      const ext = b.format === 'pain001' ? 'xml' : 'csv';
      return { fileName: `${b.number ?? 'run'}${b.format === 'cheque' ? '-cheques' : ''}.${ext}`, mime: b.format === 'pain001' ? 'application/xml; charset=utf-8' : 'text/csv; charset=utf-8', content, sha256: b.contentSha256 };
    });
  }

  /** The bank paid (or the cheques went out): every voucher is recorded as paid together, or none is. */
  async confirm(ctx: FinanceContext, id: string, input: { reference: string; paidOn: string }, now: Date = new Date()): Promise<{ paid: number }> {
    const reference = trimToNull(input.reference);
    if (!has(reference)) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the reference of the payment: the bank’s batch number or, for cheques, a note of the cheque run.');
    const paid: PaidResult[] = [];
    await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status !== 'released') throw new FinanceError('WRONG_STATE', 'Only a released run can be confirmed as paid.');
      const refusal = confirmRefusal(ctx.actor.id ?? '', b.releasedBy);
      if (refusal !== null) throw new FinanceError('SAME_PERSON', refusal);
      for (const v of await this.vouchersOf(tx, id)) {
        paid.push(await this.payments.payIn(tx, ctx, v.id, { reference: `${reference} / ${v.chequeNo ?? v.number ?? ''}`, paidOn: input.paidOn }, now));
      }
      await tx.update(vendorPaymentBatches).set({ status: 'confirmed', confirmedBy: ctx.actor.id, confirmedAt: now, bankReference: reference.slice(0, 120), updatedAt: now }).where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'confirmed', 'released', 'confirmed', { data: { reference, paid: paid.length } });
    });
    for (const p of paid) await this.payments.tellPaid(p);
    return { paid: paid.length };
  }

  /**
   * Before it is paid, a run can be dropped. Vouchers still being written or waiting for approval are cancelled with it; vouchers
   * that were already approved stay approved, out of the run, so they can be paid on their own.
   */
  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the run is cancelled.');
    await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, ctx.companyId, id);
      if (b.status === 'confirmed' || b.status === 'cancelled') throw new FinanceError('WRONG_STATE', b.status === 'confirmed' ? 'A paid run cannot be cancelled. Reverse its vouchers.' : 'This run is already cancelled.');
      for (const v of await this.vouchersOf(tx, id)) {
        if (v.status === 'draft' || v.status === 'pending_approval') await this.payments.cancel(ctx, v.id, `Run ${b.number ?? ''} cancelled: ${text}`, now, tx);
        await tx.update(vendorPaymentVouchers).set({ batchId: null, chequeNo: null }).where(eq(vendorPaymentVouchers.id, v.id));
      }
      await tx.update(vendorPaymentBatches).set({ status: 'cancelled', cancelReason: text.slice(0, 500), cancelledBy: ctx.actor.id, cancelledAt: now, updatedAt: now }).where(eq(vendorPaymentBatches.id, id));
      await this.event(tx, ctx.actor, id, 'cancelled', b.status, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(companyId: string, f: { status?: string; before?: { stamp: string; id: string } | null }, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ b: vendorPaymentBatches, stamp: sql<string>`${vendorPaymentBatches.createdAt}::text` })
      .from(vendorPaymentBatches)
      .where(and(eq(vendorPaymentBatches.companyId, companyId), has(f.status) ? eq(vendorPaymentBatches.status, f.status as VendorBatchStatus) : undefined, f.before === undefined || f.before === null ? undefined : sql`(${vendorPaymentBatches.createdAt}::text, ${vendorPaymentBatches.id}::text) < (${f.before.stamp}, ${f.before.id})`))
      .orderBy(desc(vendorPaymentBatches.createdAt), desc(vendorPaymentBatches.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.b.id, number: x.b.number ?? '', status: x.b.status, total: x.b.total, currency: x.b.currency, count: x.b.itemCount, executionDate: x.b.executionDate, createdAt: x.b.createdAt.toISOString() })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.b.id } : null,
    };
  }

  async get(companyId: string, id: string) {
    const [b] = await this.db.select().from(vendorPaymentBatches).where(and(eq(vendorPaymentBatches.companyId, companyId), eq(vendorPaymentBatches.id, id)));
    if (b === undefined) return null;
    const method = await this.payments.methodForRun(companyId, b.methodId).catch(() => null);
    const [vouchers, events] = await Promise.all([
      this.db
        .select({ v: vendorPaymentVouchers, vendorName: vendors.legalName })
        .from(vendorPaymentVouchers)
        .innerJoin(vendors, eq(vendors.id, vendorPaymentVouchers.vendorId))
        .where(eq(vendorPaymentVouchers.batchId, id))
        .orderBy(asc(vendors.legalName), asc(vendorPaymentVouchers.id)),
      this.db.select().from(vendorPaymentBatchEvents).where(eq(vendorPaymentBatchEvents.batchId, id)).orderBy(desc(vendorPaymentBatchEvents.id)).limit(100),
    ]);
    const ids = [b.createdBy, b.approvedBy, b.releasedBy, b.confirmedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x));
    const named = ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(ids)]));
    const names = new Map(named.map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const lines = vouchers.length === 0 ? [] : await this.db.select({ voucherId: vendorPaymentVoucherLines.voucherId, n: sql<number>`count(*)::int` }).from(vendorPaymentVoucherLines).where(inArray(vendorPaymentVoucherLines.voucherId, vouchers.map((x) => x.v.id))).groupBy(vendorPaymentVoucherLines.voucherId);
    const counts = new Map(lines.map((l) => [l.voucherId, l.n]));
    return {
      batch: { ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString(), submittedAt: b.submittedAt?.toISOString() ?? null, approvedAt: b.approvedAt?.toISOString() ?? null, releasedAt: b.releasedAt?.toISOString() ?? null, confirmedAt: b.confirmedAt?.toISOString() ?? null, cancelledAt: b.cancelledAt?.toISOString() ?? null, fileCreatedAt: b.fileCreatedAt?.toISOString() ?? null },
      method: method === null ? null : { name: method.name, kind: method.kind },
      createdName: who(b.createdBy),
      approvedName: who(b.approvedBy),
      releasedName: who(b.releasedBy),
      confirmedName: who(b.confirmedBy),
      vouchers: vouchers.map((x) => ({ id: x.v.id, number: x.v.number, status: x.v.status, vendorName: x.vendorName, amount: x.v.cashAmount, withheld: x.v.withholdingAmount, discount: x.v.discountAmount, destination: x.v.destination, chequeNo: x.v.chequeNo, invoices: counts.get(x.v.id) ?? 0, createdBy: x.v.createdBy })),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}
