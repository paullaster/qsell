import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { refundKit } from './refund-test-kit';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))('bank payment files for refunds (database)', () => {
  const k = refundKit('RFILE');
  const bankDetails = { bankName: 'KCB', accountNumber: '1234567890', accountName: 'Jane Wanjiru' };
  let maker: string;
  let confirmer: string;
  let makerCtx: typeof k.ctx;
  let confirmCtx: typeof k.ctx;

  beforeAll(async () => {
    [maker, confirmer] = await Promise.all([k.user('maker'), k.user('confirmer')]);
    makerCtx = { ...k.ctx, actor: { type: 'user', id: maker } };
    confirmCtx = { ...k.ctx, actor: { type: 'user', id: confirmer } };
    // the company's own bank account number, which the ISO file names as the account to debit
    const [m] = await k.db.select().from(k.schema.paymentMethods).where(eq(k.schema.paymentMethods.id, k.methodId.BANK_TRANSFER));
    await k.db.update(k.schema.bankAccounts).set({ details: { accountNumber: '0011223344', bankName: 'KCB' } }).where(eq(k.schema.bankAccounts.id, required(m.balancingBankAccountId)));
  });

  /** An approved bank-transfer refund of `amount` (no workflow covers bank transfers, so it is approved at once). */
  async function approved(amount = '580', details: Record<string, string> = bankDetails) {
    const o = await k.owed();
    const r = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, amount, { paymentMethodId: k.methodId.BANK_TRANSFER, payoutDetails: details });
    await k.fin.refunds.submit(k.ctx, r.id);
    return { o, r };
  }
  const row = async (id: string) => (await k.db.select().from(k.schema.refundPaymentFiles).where(eq(k.schema.refundPaymentFiles.id, id)))[0];
  const attach = (id: string, by = confirmCtx) => k.fin.refundFiles.attach(by, id, { mediaAssetId: 'media_bank', fileName: 'bank-confirmation.png' });

  describe('making a file', () => {
    it('puts approved bank transfers in a CSV, keeps it exactly as made, and marks each refund as waiting in it', async () => {
      const a = await approved('580');
      const b = await approved('120');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id, b.r.id] });
      expect(made).toMatchObject({ count: 2, total: '700.00' });
      expect(made.number).toMatch(/^RPF-/);
      const f = await row(made.id);
      expect(f).toMatchObject({ status: 'generated', format: 'csv', currency: 'KES', itemCount: 2, createdBy: maker });
      expect(f.content).toContain(`${a.r.number},Jane Wanjiru,KCB,1234567890,580.00,KES,Refund ${a.r.number}`);
      expect(f.content.split('\r\n')[0]).toBe('Reference,Beneficiary name,Bank,Account number,Amount,Currency,Narrative');
      const events = await k.db.select().from(k.schema.refundEvents).where(eq(k.schema.refundEvents.refundId, a.r.id)).orderBy(k.schema.refundEvents.id);
      expect(events.at(-1)).toMatchObject({ event: 'added_to_payment_file' });
      // the same refund cannot go in a second live file
      expect(await k.codeOf(k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id] }))).toBe('ALREADY_IN_FILE');
      expect((await k.fin.refundFiles.candidates(k.companyId)).map((x) => x.r.id)).not.toContain(a.r.id);
    });

    it('makes an ISO 20022 file with the control sum, once the bank account has a number', async () => {
      const a = await approved('333.50');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'pain001', refundIds: [a.r.id] });
      const f = await row(made.id);
      expect(f.content).toContain('<CtrlSum>333.50</CtrlSum>');
      expect(f.content).toContain('<Id>0011223344</Id>');
      expect(f.content).toContain(`<EndToEndId>${a.r.number}</EndToEndId>`);
      const [m] = await k.db.select().from(k.schema.paymentMethods).where(eq(k.schema.paymentMethods.id, k.methodId.BANK_TRANSFER));
      const bank = required(m.balancingBankAccountId);
      await k.db.update(k.schema.bankAccounts).set({ details: {} }).where(eq(k.schema.bankAccounts.id, bank));
      const b = await approved('50');
      expect(await k.codeOf(k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'pain001', refundIds: [b.r.id] }))).toBe('BANK_ACCOUNT_NUMBER_MISSING');
      await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [b.r.id] });
      await k.db.update(k.schema.bankAccounts).set({ details: { accountNumber: '0011223344', bankName: 'KCB' } }).where(eq(k.schema.bankAccounts.id, bank));
    });

    it('refuses what does not belong: nothing chosen, drafts, other ways of paying, unknown refunds, past dates, unknown formats', async () => {
      const o = await k.owed();
      const draft = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '50', { paymentMethodId: k.methodId.BANK_TRANSFER, payoutDetails: bankDetails });
      const make = (ids: string[], extra: Record<string, unknown> = {}) => k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: ids, ...extra } as never);
      expect(await k.codeOf(make([]))).toBe('NOTHING_TO_SEND');
      expect(await k.codeOf(make([draft.id]))).toBe('NOT_APPROVED');
      expect(await k.codeOf(make([randomUUID()]))).toBe('NOT_FOUND');
      const cash = await k.owed();
      const cashRefund = await k.request(cash.customer.id, 'credit_note_excess', cash.cn.id, '60');
      await k.fin.refunds.submit(k.ctx, cashRefund.id);
      expect(await k.codeOf(make([cashRefund.id]))).toBe('REFUND_NOT_FIT');
      const ok = await approved('70');
      expect(await k.codeOf(make([ok.r.id], { executionDate: '2020-01-01' }))).toBe('DATE_INVALID');
      expect(await k.codeOf(make([ok.r.id], { format: 'xlsx' }))).toBe('FORMAT_INVALID');
      expect(await k.codeOf(k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.CASH, format: 'csv', refundIds: [ok.r.id] }))).toBe('BANK_INVALID');
      expect(await k.codeOf(make(Array.from({ length: 501 }, () => randomUUID())))).toBe('TOO_MANY');
    });

    it('is built from the details as they were, with nothing that can break out of the file', async () => {
      const a = await approved('90', { bankName: 'Equity', accountNumber: '99', accountName: '=SUM(A1:A9)+"x",y' });
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id] });
      const line = (await row(made.id)).content.split('\r\n')[1];
      expect(line.startsWith(`${a.r.number},"'=SUM(A1:A9)+""x"",y",Equity,99,90.00,KES`)).toBe(true);
    });
  });

  describe('while a refund waits in a file', () => {
    it('it cannot be cancelled or paid by hand; cancelling the file frees it', async () => {
      const a = await approved('200');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id] });
      expect(await k.codeOf(k.fin.refunds.cancel(k.ctx, a.r.id, { code: 'CUSTOMER_REQUEST' }))).toBe('IN_PAYMENT_FILE');
      expect(await k.codeOf(k.payOut(a.r.id, confirmCtx, k.methodId.BANK_TRANSFER))).toBe('IN_PAYMENT_FILE');
      await k.fin.refundFiles.cancel(makerCtx, made.id, { code: 'DATA_ENTRY_ERROR' });
      expect((await row(made.id)).status).toBe('cancelled');
      expect(await k.codeOf(k.fin.refundFiles.cancel(makerCtx, made.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('BAD_STATE');
      // free again: in a new file, or paid another way
      expect((await k.fin.refundFiles.candidates(k.companyId)).map((x) => x.r.id)).toContain(a.r.id);
      await k.payOut(a.r.id, confirmCtx, k.methodId.BANK_TRANSFER);
      expect(await k.status(a.r.id)).toBe('paid');
      // a cancelled file is not for the bank any more
      expect(await k.codeOf(k.fin.refundFiles.download(makerCtx, made.id))).toBe('NOT_ACTIVE');
    });
  });

  describe('downloading', () => {
    it('gives the file as made, counts every download, and refuses a cancelled one', async () => {
      const a = await approved('45');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'pain001', refundIds: [a.r.id] });
      const one = await k.fin.refundFiles.download(makerCtx, made.id);
      expect(one).toMatchObject({ fileName: `${made.number}.xml`, mime: 'application/xml; charset=utf-8' });
      expect(one.content).toBe((await row(made.id)).content);
      await k.fin.refundFiles.download(makerCtx, made.id);
      expect((await row(made.id)).downloads).toBe(2);
      const decisions = await k.db.select().from(k.schema.decisionLog).where(eq(k.schema.decisionLog.subjectId, made.id));
      expect(decisions.filter((d) => d.action === 'finance.refund_file_downloaded')).toHaveLength(2);
    });

    it('cannot be changed after it was made, nor deleted', async () => {
      const a = await approved('35');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id] });
      await expect(k.db.update(k.schema.refundPaymentFiles).set({ content: 'x' }).where(eq(k.schema.refundPaymentFiles.id, made.id))).rejects.toThrow();
      await expect(k.db.update(k.schema.refundPaymentFiles).set({ total: '1.00' }).where(eq(k.schema.refundPaymentFiles.id, made.id))).rejects.toThrow();
      await expect(k.db.delete(k.schema.refundPaymentFiles).where(eq(k.schema.refundPaymentFiles.id, made.id))).rejects.toThrow();
      await expect(k.db.delete(k.schema.refundPaymentFileItems).where(eq(k.schema.refundPaymentFileItems.fileId, made.id))).rejects.toThrow();
    });
  });

  it('another company cannot see or confirm a file', async () => {
    const a = await approved('55');
    const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id] });
    const stranger = { ...confirmCtx, companyId: randomUUID() };
    expect(await k.fin.refundFiles.detail(stranger.companyId, made.id)).toBeNull();
    expect(await k.codeOf(k.fin.refundFiles.confirm(stranger, made.id, { bankReference: 'X' }))).toBe('NOT_FOUND');
    expect(await k.codeOf(k.fin.refundFiles.download(stranger, made.id))).toBe('NOT_FOUND');
    expect((await k.fin.refundFiles.list(k.companyId)).map((f) => f.id)).toContain(made.id);
    expect(await k.fin.refundFiles.list(stranger.companyId)).toEqual([]);
  });

  describe('when the bank has paid', () => {
    it('records every refund as paid together with the bank\'s reference, once someone other than the maker confirms with evidence', async () => {
      const a = await approved('300');
      const b = await approved('150');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id, b.r.id] });
      const confirm = (by = confirmCtx, ref = 'BATCH-77') => k.fin.refundFiles.confirm(by, made.id, { bankReference: ref });
      expect(await k.codeOf(confirm(makerCtx))).toBe('SAME_PERSON');
      expect(await k.codeOf(confirm(confirmCtx, '  '))).toBe('REFERENCE_REQUIRED');
      expect(await k.codeOf(confirm())).toBe('EVIDENCE_REQUIRED');
      await attach(made.id);
      expect(await confirm()).toEqual({ paid: 2 });
      const paid = await k.db.select().from(k.schema.refundRequests).where(eq(k.schema.refundRequests.id, a.r.id));
      expect(paid[0]).toMatchObject({ status: 'paid', payoutReference: `BATCH-77 / ${a.r.number}`, paidBy: confirmer });
      const bank = await k.db.select().from(k.schema.bankLedgerEntries).where(eq(k.schema.bankLedgerEntries.documentId, b.r.id));
      expect(bank.map((x) => Number(x.amount))).toEqual([-150]);
      expect(await row(made.id)).toMatchObject({ status: 'confirmed', confirmedBy: confirmer, bankReference: 'BATCH-77' });
      const items = await k.db.select().from(k.schema.refundPaymentFileItems).where(eq(k.schema.refundPaymentFileItems.fileId, made.id));
      expect(items.map((i) => i.state)).toEqual(['paid', 'paid']);
      // done once
      expect(await k.codeOf(confirm())).toBe('BAD_STATE');
      expect(await k.codeOf(k.fin.refundFiles.cancel(makerCtx, made.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('BAD_STATE');
      expect(await k.fin.customerLedger.drift(k.companyId)).toEqual([]);
    });

    it('is all or nothing: one refund that cannot be recorded leaves every other refund unpaid', async () => {
      const a = await approved('310');
      const b = await approved('160');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [a.r.id, b.r.id] });
      await attach(made.id);
      // someone else paid one of them in the meantime, through a route that does not look at files
      await k.db.update(k.schema.refundRequests).set({ approvedBy: confirmer }).where(eq(k.schema.refundRequests.id, b.r.id));
      expect(await k.codeOf(k.fin.refundFiles.confirm(confirmCtx, made.id, { bankReference: 'BATCH-88' }))).toBe('SAME_PERSON');
      expect(await k.status(a.r.id)).toBe('approved');
      expect(await k.status(b.r.id)).toBe('approved');
      expect((await row(made.id)).status).toBe('generated');
      const items = await k.db.select().from(k.schema.refundPaymentFileItems).where(eq(k.schema.refundPaymentFileItems.fileId, made.id));
      expect(items.map((i) => i.state)).toEqual(['in_file', 'in_file']);
    });

    it('does not let the person who approved a refund make a file for it', async () => {
      await k.workflow('refund.payout', k.boss, { op: 'eq', field: 'methodKind', value: 'bank_transfer' });
      const o = await k.owed();
      const r = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '410', { paymentMethodId: k.methodId.BANK_TRANSFER, payoutDetails: bankDetails });
      expect((await k.fin.refunds.submit(k.reqCtx, r.id)).status).toBe('pending_approval');
      await k.approve((await k.openEntry('refund', r.id)).id, k.boss);
      expect(await k.status(r.id)).toBe('approved');
      expect(await k.codeOf(k.fin.refundFiles.generate(k.bossCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [r.id] }))).toBe('SAME_PERSON');
      const made = await k.fin.refundFiles.generate(makerCtx, { methodId: k.methodId.BANK_TRANSFER, format: 'csv', refundIds: [r.id] });
      await attach(made.id, confirmCtx);
      expect(await k.codeOf(k.fin.refundFiles.confirm(k.bossCtx, made.id, { bankReference: 'BATCH-99' }))).toBe('SAME_PERSON');
      await k.fin.refundFiles.confirm(confirmCtx, made.id, { bankReference: 'BATCH-99' });
      expect(await k.status(r.id)).toBe('paid');
    });
  });

});
