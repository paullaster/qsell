import { describe, expect, it } from 'vitest';
import type { CompanyProfile } from '@/server/ports/communications';
import { renderReceiptPdf } from '@/server/adapters/pdf/pdfkit-receipt.adapter';
import { buildReceiptDocument, receiptFileName } from './receipt-document';

const company: CompanyProfile = {
  legalName: 'Acme Ltd', tradingName: 'Acme', email: 'a@acme.test', phone: '0700', streetAddress: '1 Road', city: 'Nairobi',
  countyOrState: 'Nairobi', postalCode: '00100', country: 'Kenya', kraPin: 'P000', invoicePrefix: 'INV', primaryColor: '#111827', accentColor: '#4F46E5',
};

const detail = (over: Record<string, unknown> = {}, apps: { document_no: string; amount: string; undone: boolean }[] = []) =>
  ({
    receipt: {
      number: 'PAY-0001', status: 'posted', currency: 'KES', amount: '1500.00', rate: '1', paymentDate: '2026-10-20', postingDate: '2026-10-20',
      externalReference: 'QX1', payerName: null, narration: null, counterparty: {}, isDeposit: false, postedBy: 'u1', ...over,
    },
    customer: { name: 'Alice Cash', number: 'C0001' },
    method: { name: 'Cash' },
    actors: { u1: 'Wanjiru' },
    events: [{ event: 'reversed', createdAt: new Date('2026-10-21T08:00:00Z') }],
    applications: apps.map((a, i) => ({ application_id: String(i), invoice_id: 'x', at: '', undone_by: null, ...a })),
    unappliedCents: 0,
  }) as unknown as Parameters<typeof buildReceiptDocument>[0];

describe('receipt document', () => {
  it('refuses a draft and a cancelled receipt', () => {
    expect(() => buildReceiptDocument(detail({ status: 'draft' }), company)).toThrow(/Post it first/);
    expect(() => buildReceiptDocument(detail({ status: 'cancelled' }), company)).toThrow(/cancelled/);
  });

  it('lists only applications that still stand, and names who received it', () => {
    const doc = buildReceiptDocument(detail({}, [{ document_no: 'INV-1', amount: '1000.00', undone: false }, { document_no: 'INV-2', amount: '500.00', undone: true }]), company);
    expect(doc.applications).toEqual([{ invoiceNo: 'INV-1', amount: '1000.00' }]);
    expect(doc.receivedBy).toBe('Wanjiru');
    expect(doc.rate).toBeNull();
    expect(doc.reversedOn).toBeNull();
  });

  it('carries cheque details, the foreign rate and the reversal date', () => {
    const doc = buildReceiptDocument(detail({ status: 'reversed', currency: 'USD', rate: '129.5', counterparty: { chequeNo: '0042', bank: 'KCB', drawer: 'Alice', chequeDate: '2026-10-19' } }), company);
    expect(doc.cheque).toEqual({ number: '0042', bank: 'KCB', drawer: 'Alice', date: '2026-10-19' });
    expect(doc.rate).toBe('129.5');
    expect(doc.reversedOn).toBe('2026-10-21');
  });

  it('makes a safe file name', () => {
    expect(receiptFileName('PAY/0001 "x"')).toBe('Receipt-PAY-0001-x-.pdf');
  });

  it('renders a real PDF, for a posted and a reversed receipt', async () => {
    for (const status of ['posted', 'reversed']) {
      const pdf = await renderReceiptPdf(buildReceiptDocument(detail({ status }, [{ document_no: 'INV-1', amount: '1500.00', undone: false }]), company), '2026-10-22');
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1500);
    }
  });

  it('pages a long list of applications', async () => {
    const apps = Array.from({ length: 80 }, (_, i) => ({ document_no: `INV-${String(i)}`, amount: '10.00', undone: false }));
    const pdf = await renderReceiptPdf(buildReceiptDocument(detail({}, apps), company), '2026-10-22');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
