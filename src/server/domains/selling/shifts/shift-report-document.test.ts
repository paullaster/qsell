import { describe, expect, it } from 'vitest';
import { renderShiftReportPdf } from '@/server/adapters/pdf/pdfkit-shift-report.adapter';
import type { CompanyProfile } from '@/server/ports/communications';
import { buildShiftReportDocument } from './shift-report-document';
import type { ShiftReport } from './shift-service';

const company: CompanyProfile = { legalName: 'Test Traders Ltd', tradingName: 'Test Traders', email: 'shop@example.test', phone: '0700000000', streetAddress: '1 Test Road', city: 'Nairobi', countyOrState: 'Nairobi', postalCode: '00100', country: 'Kenya', kraPin: 'P000000000X', invoicePrefix: 'INV', primaryColor: '#111827', accentColor: '#4F46E5' };
const report = (over: Partial<ShiftReport> = {}): ShiftReport => ({
  id: 'abcdef12-0000-4000-8000-000000000000', status: 'open', registerName: 'Till 1', branchName: 'Head office', openedBy: 'Wanjiku', openedById: 'u1', openedAt: '2026-11-20T18:53:00.000Z',
  closedBy: null, closedAt: null, openingFloat: 25920, openingCounted: [], paidIn: 0, paidOut: 0, cashSales: 182, expectedCash: 26102, declaredCash: null, closingCounted: [], variance: null, varianceReason: null, zNumber: null,
  takings: { count: 1, cash: 182, mobileMoney: 0, card: 0, refunds: 0, cashRefunds: 0 }, differencePosting: null, closeRequest: null, movements: [], ...over,
});
const NOW = new Date('2026-11-21T06:39:00.000Z');

describe('the printed shift report', () => {
  it('is the X report while the shift is open, with the figures worked out and times in the business zone', () => {
    const d = buildShiftReportDocument(report(), company, 'Africa/Nairobi', NOW);
    expect(d.title).toBe('X REPORT');
    expect(d.number).toBe('Shift so far');
    expect(d.cash.find((r) => r.strong)?.value).toBe('KES 26,102.00');
    expect(d.meta[1]?.[1]).toContain('21:53');
    expect(d.printedOn).toContain('09:39');
  });

  it('is the Z report once closed: numbered, with the count, the difference and its reason', () => {
    const d = buildShiftReportDocument(report({ status: 'closed', zNumber: 'Z-0007', closedAt: '2026-11-21T14:00:00.000Z', closedBy: 'Otieno', declaredCash: 26000, variance: -102, varianceReason: 'Short on change', closingCounted: [{ value: 1000, count: 26 }], takings: { count: 3, cash: 182, mobileMoney: 500, card: 250, refunds: 40, cashRefunds: 40 } }), company, 'Africa/Nairobi', NOW);
    expect(d.title).toBe('Z REPORT');
    expect(d.number).toBe('Z-0007');
    expect(d.cash.map((r) => r.label)).toEqual(expect.arrayContaining(['Counted at the close', 'Difference', 'Cash handed back for returns']));
    expect(d.cash.find((r) => r.label === 'Difference')?.value).toBe('KES -102.00');
    expect(d.other.map((r) => r.label)).toEqual(expect.arrayContaining(['Taken by M-Pesa (not in the till)', 'Taken by card (not in the till)']));
    expect(d.counted[0]).toEqual({ label: '1,000 x 26', value: 'KES 26,000.00' });
    expect(d.note).toContain('Short on change');
  });

  it('makes a real PDF, and carries on to another page when there is a lot of cash in and out', async () => {
    const one = await renderShiftReportPdf(buildShiftReportDocument(report(), company, 'Africa/Nairobi', NOW));
    expect(one.subarray(0, 5).toString()).toBe('%PDF-');
    const movements = Array.from({ length: 60 }, (_, n) => ({ kind: 'paid_in' as const, amount: 100 + n, reason: `Float top-up ${String(n)}`, by: 'Wanjiku', at: '2026-11-20T19:00:00.000Z' }));
    const many = await renderShiftReportPdf(buildShiftReportDocument(report({ movements }), company, 'Africa/Nairobi', NOW));
    expect(many.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
  });
});
