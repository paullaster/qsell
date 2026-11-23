import { describe, expect, it } from 'vitest';
import type { StatementDownload } from '@/lib/customer-statement';
import type { CompanyProfile } from '@/server/ports/communications';
import { renderCustomerStatementPdf } from './pdfkit-customer-statement.adapter';

const company: CompanyProfile = {
  legalName: 'Test Company Ltd',
  tradingName: 'Test Company',
  email: 'admin@example.test',
  phone: '0700000000',
  streetAddress: '1 Test Street',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  postalCode: '00100',
  country: 'Kenya',
  kraPin: 'P000000000X',
  invoicePrefix: 'INV',
  primaryColor: '#111827',
  accentColor: '#4F46E5',
};

const statement: StatementDownload = {
  customerName: 'Test Customer',
  customerNumber: 'CUS-001',
  customerKraPin: 'A123456789Z',
  customerAddress: ['1 Market Road', 'Nairobi, Nairobi, 00100', 'Kenya'],
  paymentTerms: 'Credit (on account), 30 days',
  creditLimit: '5000.00',
  currency: 'KES',
  statementDate: '2026-09-30',
  ageing: [
    { label: 'Not yet due', amount: '100.00', count: 1 },
    { label: '1–30 days', amount: '200.00', count: 2 },
  ],
  from: '2026-09-01',
  to: '2026-09-30',
  openingBalance: '100.00',
  totalDebit: '250.00',
  totalCredit: '50.00',
  closingBalance: '300.00',
  lines: [
    {
      date: '2026-09-02',
      document: 'Tax invoice INV-17',
      description: 'Goods',
      dueDate: '2026-10-02',
      debit: '250.00',
      credit: '—',
      balance: '350.00',
    },
  ],
};

describe('renderCustomerStatementPdf', () => {
  it('produces a PDF document with the statement content', async () => {
    const pdf = await renderCustomerStatementPdf(statement, company, '2026-09-30T12:00:00.000Z');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
