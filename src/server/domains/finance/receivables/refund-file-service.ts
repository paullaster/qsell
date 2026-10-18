import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  companySettings,
  customers,
  financeAttachments,
  paymentMethods,
  refundPaymentFileItems,
  refundPaymentFiles,
  refundRequests,
  users,
  type RefundFileFormat,
  type RefundPaymentFileRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { fromCents, toCents } from '../domain/receivables';
import { MAX_FILE_LINES, buildCsv, buildPain001, lineProblem, sha256, type FileLine } from '../domain/refund-file';
import { NO_SPECIAL_PERMISSIONS, type PostingPermissions, type Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { RefundService } from './refund-service';

import { filledStrings, has, orElse } from '@/lib/values';

export interface GenerateInput {
  methodId: string;
  format: RefundFileFormat;
  refundIds: string[];
  /** The day the bank should pay; today when left out. */
  executionDate?: string;
}

const LATEST_DAYS_AHEAD = 30;

/**
 * Bank payment files for refunds paid by bank transfer: approved refunds are put into one file that is uploaded to the
 * bank, kept exactly as made, and recorded as paid together when the bank confirms. A refund is in one live file at a time,
 * and the person who makes the file, the person who approved each refund and the person who confirms the bank paid
 * are three different checks.
 */
export class RefundFileService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly refunds: RefundService,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
  ) {}

  /** Approved bank-transfer refunds that are in no file, the oldest first, for building one. */
  async candidates(companyId: string, f: { currency?: string; limit?: number } = {}) {
    const limit = Math.min(f.limit ?? 200, MAX_FILE_LINES);
    const rows = await this.db
      .select({ r: refundRequests, customerName: customers.name, kind: paymentMethods.kind })
      .from(refundRequests)
      .innerJoin(customers, eq(customers.id, refundRequests.customerId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, refundRequests.paymentMethodId))
      .where(
        and(
          eq(refundRequests.companyId, companyId),
          eq(refundRequests.status, 'approved'),
          eq(paymentMethods.kind, 'bank_transfer'),
          has(f.currency) ? eq(refundRequests.currency, f.currency) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM refund_payment_file_items i WHERE i.refund_id = ${refundRequests.id} AND i.state = 'in_file')`,
        ),
      )
      .orderBy(asc(refundRequests.approvedAt), asc(refundRequests.id))
      .limit(limit);
    return rows;
  }

  async generate(ctx: FinanceContext, input: GenerateInput): Promise<{ id: string; number: string; count: number; total: string }> {
    const ids = [...new Set(input.refundIds)];
    if (ids.length === 0) throw new FinanceError('NOTHING_TO_SEND', 'Choose at least one refund to put in the file.');
    if (ids.length > MAX_FILE_LINES) throw new FinanceError('TOO_MANY', `A file holds at most ${String(MAX_FILE_LINES)} refunds.`);
    // The browser is not trusted to send one of the two formats.
    const requested: string = input.format;
    if (requested !== 'csv' && requested !== 'pain001') throw new FinanceError('FORMAT_INVALID', 'Choose a file format.');
    const today = businessDate();
    const executionDate = input.executionDate ?? today;
    const latest = new Date(Date.parse(`${today}T00:00:00Z`) + LATEST_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(executionDate) || executionDate < today || executionDate > latest) throw new FinanceError('DATE_INVALID', `The bank should pay from today up to ${String(LATEST_DAYS_AHEAD)} days ahead.`);

    return await this.db.transaction(async (tx) => {
      const [from] = await tx
        .select({ method: paymentMethods, bank: bankAccounts })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.methodId)));
      if (!from || from.bank.blocked || !from.method.enabled || from.bank.kind !== 'bank') throw new FinanceError('BANK_INVALID', 'Choose the bank payment method the money will be paid from.');
      const currency = from.bank.currency;
      const account = orElse(from.bank.details.accountNumber, '').trim();
      if (input.format === 'pain001' && account === '') throw new FinanceError('BANK_ACCOUNT_NUMBER_MISSING', `${from.bank.code} has no account number on record. Add it to the bank account before making an ISO 20022 file.`);

      // Locked in a fixed order so two people building files at once cannot wait on each other for ever.
      const rows = await tx
        .select({ r: refundRequests, kind: paymentMethods.kind })
        .from(refundRequests)
        .innerJoin(paymentMethods, eq(paymentMethods.id, refundRequests.paymentMethodId))
        .where(and(eq(refundRequests.companyId, ctx.companyId), inArray(refundRequests.id, ids)))
        .orderBy(asc(refundRequests.id))
        .for('update', { of: refundRequests });
      if (rows.length !== ids.length) throw new FinanceError('NOT_FOUND', 'One of those refunds does not exist.');
      for (const { r, kind } of rows) {
        if (r.status !== 'approved') throw new FinanceError('NOT_APPROVED', `${r.number} is ${r.status.replace('_', ' ')}; only approved refunds can be put in a file.`);
        if (has(r.approvedBy) && r.approvedBy === ctx.actor.id) throw new FinanceError('SAME_PERSON', `You approved ${r.number}, so you cannot also be the one who sends its payment to the bank.`);
        const problem = lineProblem({ number: r.number, currency: r.currency, kind, details: r.payoutDetails }, currency);
        if (problem !== null) throw new FinanceError('REFUND_NOT_FIT', problem);
        const inFile = await this.refunds.liveFileOf(tx, r.id);
        if (inFile) throw new FinanceError('ALREADY_IN_FILE', `${r.number} is already in bank payment file ${inFile.number}.`);
      }
      const ordered = [...rows].sort((a, b) => a.r.number.localeCompare(b.r.number));
      const lines: FileLine[] = ordered.map(({ r }) => {
        const d = filledStrings(r.payoutDetails);
        return { endToEndId: r.number, amountCents: toCents(r.amount), beneficiary: { name: orElse(d.accountName, ''), bank: orElse(d.bankName, ''), account: orElse(d.accountNumber, '') }, narrative: `Refund ${r.number}` };
      });

      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('refund_file', { companyId: ctx.companyId, branchId: undefined, date: today, document: { kind: 'refund_file', id }, actor: ctx.actor }, tx);
      const [company] = await tx.select({ name: companySettings.tradingName }).from(companySettings).where(eq(companySettings.id, ctx.companyId));
      const content = input.format === 'csv' ? buildCsv(lines, currency) : buildPain001({ messageId: number, createdAt: new Date(), executionDate, debtor: { name: orElse(company?.name, 'Company'), account }, currency, lines });
      const totalCents = lines.reduce((n, l) => n + l.amountCents, 0);
      await tx.insert(refundPaymentFiles).values({ id, companyId: ctx.companyId, number, methodId: from.method.id, format: input.format, currency, total: fromCents(totalCents), itemCount: lines.length, content, contentSha256: sha256(content), createdBy: ctx.actor.id ?? 'system' });
      await tx.insert(refundPaymentFileItems).values(ordered.map(({ r }, i) => ({ fileId: id, refundId: r.id, amount: r.amount, beneficiary: lines[i].beneficiary, endToEndId: lines[i].endToEndId })));
      for (const { r } of ordered) await this.refunds.noteEventIn(tx, ctx, r.id, 'added_to_payment_file', { file: number, format: input.format });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund_payment_file', id }, action: 'finance.refund_file_generated', actor: ctx.actor, inputs: { origin: ctx.origin, format: input.format, method: from.method.code }, outcome: { number, count: lines.length, total: fromCents(totalCents), sha256: sha256(content) } }, tx);
      return { id, number, count: lines.length, total: fromCents(totalCents) };
    });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<RefundPaymentFileRow> {
    const [f] = await tx.select().from(refundPaymentFiles).where(and(eq(refundPaymentFiles.companyId, companyId), eq(refundPaymentFiles.id, id))).for('update');
    if (!f) throw new FinanceError('NOT_FOUND', 'That payment file does not exist.');
    return f;
  }

  async evidenceCount(db: Pick<DrizzleDb, 'select'>, id: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(financeAttachments).where(and(eq(financeAttachments.subjectType, 'refund_payment_file'), eq(financeAttachments.subjectId, id)));
    return r?.n ?? 0;
  }

  async attach(ctx: FinanceContext, id: string, file: { mediaAssetId: string; fileName: string; note?: string | null }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const f = await this.lock(tx, ctx.companyId, id);
      if (f.status === 'cancelled') throw new FinanceError('NOT_ACTIVE', 'This payment file was cancelled.');
      await tx.insert(financeAttachments).values({ companyId: ctx.companyId, subjectType: 'refund_payment_file', subjectId: id, mediaAssetId: file.mediaAssetId, fileName: file.fileName, note: file.note ?? null, uploadedBy: ctx.actor.id ?? 'system' });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund_payment_file', id }, action: 'finance.refund_file_evidence_added', actor: ctx.actor, inputs: { origin: ctx.origin, fileName: file.fileName } }, tx);
    });
  }

  /** The file as it was made, for the person uploading it to the bank. Every download is counted and kept. */
  async download(ctx: FinanceContext, id: string): Promise<{ fileName: string; mime: string; content: string; sha256: string }> {
    return await this.db.transaction(async (tx) => {
      const f = await this.lock(tx, ctx.companyId, id);
      if (f.status === 'cancelled') throw new FinanceError('NOT_ACTIVE', 'This payment file was cancelled and must not be sent to the bank.');
      if (sha256(f.content) !== f.contentSha256) throw new FinanceError('FILE_ALTERED', 'This file no longer matches the fingerprint taken when it was made. Do not send it; tell an administrator.');
      await tx.update(refundPaymentFiles).set({ downloads: f.downloads + 1 }).where(eq(refundPaymentFiles.id, id));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund_payment_file', id }, action: 'finance.refund_file_downloaded', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { number: f.number, downloads: f.downloads + 1 } }, tx);
      return { fileName: `${f.number}.${f.format === 'csv' ? 'csv' : 'xml'}`, mime: f.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8', content: f.content, sha256: f.contentSha256 };
    });
  }

  /**
   * The bank paid the file: every refund in it is recorded as paid together, with the bank's reference and the date, or none is.
   * Needs evidence of the bank's confirmation on the file, and a person who neither made the file nor approved any refund in it.
   */
  async confirm(ctx: FinanceContext, id: string, input: { bankReference: string; paidOn?: string; permissions?: PostingPermissions }): Promise<{ paid: number }> {
    const perms = input.permissions ?? NO_SPECIAL_PERMISSIONS;
    return await this.db.transaction(async (tx) => {
      const f = await this.lock(tx, ctx.companyId, id);
      if (f.status !== 'generated') throw new FinanceError('BAD_STATE', `This payment file is ${f.status}.`);
      if (f.createdBy === ctx.actor.id) throw new FinanceError('SAME_PERSON', 'The person who made the file cannot be the one who confirms the bank paid it.');
      const reference = input.bankReference.trim();
      if (!has(reference)) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the reference the bank gave for the file (its batch or payment number).');
      if ((await this.evidenceCount(tx, id)) === 0) throw new FinanceError('EVIDENCE_REQUIRED', 'Attach the bank\'s confirmation of the file first (a screenshot or statement of the batch).');
      const items = await tx.select().from(refundPaymentFileItems).where(and(eq(refundPaymentFileItems.fileId, id), eq(refundPaymentFileItems.state, 'in_file'))).orderBy(asc(refundPaymentFileItems.endToEndId));
      for (const item of items) {
        await this.refunds.recordPayoutIn(tx, ctx, item.refundId, { paidFromMethodId: f.methodId, reference: `${reference} / ${item.endToEndId}`, payoutDate: input.paidOn, permissions: perms, evidenceSatisfied: true });
        await tx.update(refundPaymentFileItems).set({ state: 'paid' }).where(eq(refundPaymentFileItems.id, item.id));
      }
      await tx.update(refundPaymentFiles).set({ status: 'confirmed', confirmedBy: ctx.actor.id, confirmedAt: new Date(), bankReference: reference }).where(eq(refundPaymentFiles.id, id));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund_payment_file', id }, action: 'finance.refund_file_confirmed', actor: ctx.actor, from: 'generated', to: 'confirmed', inputs: { origin: ctx.origin, bankReference: reference }, outcome: { number: f.number, paid: items.length, total: f.total } }, tx);
      return { paid: items.length };
    });
  }

  /** The file will not be sent (or the bank refused it): its refunds are free to go into another file or be paid another way. */
  async cancel(ctx: FinanceContext, id: string, reason: { code: string; text?: string | null }): Promise<void> {
    const rs = await this.reasons.require(ctx.companyId, reason, 'refund');
    await this.db.transaction(async (tx) => {
      const f = await this.lock(tx, ctx.companyId, id);
      if (f.status !== 'generated') throw new FinanceError('BAD_STATE', `This payment file is ${f.status}; only one that has not been confirmed can be cancelled.`);
      const items = await tx.select().from(refundPaymentFileItems).where(and(eq(refundPaymentFileItems.fileId, id), eq(refundPaymentFileItems.state, 'in_file')));
      await tx.update(refundPaymentFileItems).set({ state: 'released' }).where(and(eq(refundPaymentFileItems.fileId, id), eq(refundPaymentFileItems.state, 'in_file')));
      await tx.update(refundPaymentFiles).set({ status: 'cancelled', cancelledBy: ctx.actor.id, cancelledAt: new Date(), cancelReason: rs.text === null ? rs.code : `${rs.code}: ${rs.text}` }).where(eq(refundPaymentFiles.id, id));
      for (const item of items) await this.refunds.noteEventIn(tx, ctx, item.refundId, 'removed_from_payment_file', { file: f.number }, { text: rs.text ?? rs.code });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund_payment_file', id }, action: 'finance.refund_file_cancelled', actor: ctx.actor, from: 'generated', to: 'cancelled', reason: rs, inputs: { origin: ctx.origin }, outcome: { number: f.number, released: items.length } }, tx);
    });
  }

  async list(companyId: string, f: { status?: RefundPaymentFileRow['status']; limit?: number } = {}) {
    const rows = await this.db
      .select({ id: refundPaymentFiles.id, number: refundPaymentFiles.number, format: refundPaymentFiles.format, currency: refundPaymentFiles.currency, total: refundPaymentFiles.total, itemCount: refundPaymentFiles.itemCount, status: refundPaymentFiles.status, createdBy: refundPaymentFiles.createdBy, createdAt: refundPaymentFiles.createdAt, downloads: refundPaymentFiles.downloads })
      .from(refundPaymentFiles)
      .where(and(eq(refundPaymentFiles.companyId, companyId), has(f.status) ? eq(refundPaymentFiles.status, f.status) : undefined))
      .orderBy(desc(refundPaymentFiles.createdAt))
      .limit(Math.min(f.limit ?? 50, 200));
    return rows;
  }

  async detail(companyId: string, id: string) {
    const [file] = await this.db.select({ f: refundPaymentFiles, method: paymentMethods.name }).from(refundPaymentFiles).innerJoin(paymentMethods, eq(paymentMethods.id, refundPaymentFiles.methodId)).where(and(eq(refundPaymentFiles.companyId, companyId), eq(refundPaymentFiles.id, id)));
    if (!file) return null;
    const [items, attachments] = await Promise.all([
      this.db
        .select({ i: refundPaymentFileItems, number: refundRequests.number, customer: customers.name })
        .from(refundPaymentFileItems)
        .innerJoin(refundRequests, eq(refundRequests.id, refundPaymentFileItems.refundId))
        .innerJoin(customers, eq(customers.id, refundRequests.customerId))
        .where(eq(refundPaymentFileItems.fileId, id))
        .orderBy(asc(refundPaymentFileItems.endToEndId)),
      this.db.select().from(financeAttachments).where(and(eq(financeAttachments.companyId, companyId), eq(financeAttachments.subjectType, 'refund_payment_file'), eq(financeAttachments.subjectId, id))).orderBy(asc(financeAttachments.createdAt)),
    ]);
    const ids = [file.f.createdBy, file.f.confirmedBy, file.f.cancelledBy].filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    const named = ids.length !== 0 ? await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    return { ...file, items, attachments, actors: Object.fromEntries(named.map((u) => [u.id, orElse(u.name, u.email)])) };
  }
}
