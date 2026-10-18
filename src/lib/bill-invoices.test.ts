import { describe, expect, it } from 'vitest';
import { billStatus, invoiceNote, isOverdue, stillDue } from './bill-invoices';

describe('how Bill Manager invoices read', () => {
  it('names each state and colours it, and shows an unknown one as itself', () => {
    expect(billStatus('paid')).toEqual({ label: 'Paid', tone: 'green' });
    expect(billStatus('failed').tone).toBe('red');
    expect(billStatus('odd')).toEqual({ label: 'odd', tone: 'gray' });
  });

  it('works out what is still to pay, never below nothing', () => {
    expect(stillDue('1500.00', '500.50')).toBe('999.50');
    expect(stillDue('100.00', '100.00')).toBe('0.00');
    expect(stillDue('100.00', '150.00')).toBe('0.00');
  });

  it('is overdue only while it is sent or part paid and past due', () => {
    expect(isOverdue({ status: 'sent', dueDate: '2026-10-01' }, '2026-10-17')).toBe(true);
    expect(isOverdue({ status: 'part_paid', dueDate: '2026-10-17' }, '2026-10-17')).toBe(false);
    expect(isOverdue({ status: 'paid', dueDate: '2026-10-01' }, '2026-10-17')).toBe(false);
    expect(isOverdue({ status: 'cancelled', dueDate: '2026-10-01' }, '2026-10-17')).toBe(false);
  });

  it('says what is wrong, when something is', () => {
    const base = { status: 'sent', failureReason: null, ackError: null, acknowledged: false };
    expect(invoiceNote(base)).toBeNull();
    expect(invoiceNote({ ...base, status: 'failed', failureReason: 'Invalid phone' })).toBe('Invalid phone');
    expect(invoiceNote({ ...base, status: 'failed' })).toContain('did not accept');
    expect(invoiceNote({ ...base, status: 'paid', ackError: 'The operation is off' })).toContain('not told: The operation is off');
    expect(invoiceNote({ ...base, status: 'paid' })).toContain('may not have a receipt');
    expect(invoiceNote({ ...base, status: 'paid', acknowledged: true })).toBeNull();
  });
});
