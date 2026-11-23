import { describe, expect, it } from 'vitest';
import { acceptanceNotice, acceptanceSentences, checkAcceptance, DEFAULT_ACCEPTANCE, isAcceptanceMode, readAcceptance, type AcceptanceFacts } from './quote-acceptance';

const base: Omit<AcceptanceFacts, 'outcome'> = { quoteNumber: 'QTE-7', customerName: 'Acme <Ltd>', total: '12400', currency: 'KES', shop: 'Bigbro', path: '/admin/quotes', link: 'https://shop.test/admin/quotes' };

describe('what happens when a customer accepts a quote', () => {
  it('keeps making a sales order and telling staff by email and browser alert until someone chooses', () => {
    expect(DEFAULT_ACCEPTANCE).toEqual({ onAcceptance: 'sales_order', notifyEmail: true, notifySms: false, notifyPush: true });
    expect(readAcceptance(undefined)).toEqual(DEFAULT_ACCEPTANCE);
    expect(readAcceptance({ onAcceptance: 'refund', notifyEmail: 'yes' })).toEqual(DEFAULT_ACCEPTANCE);
    expect(readAcceptance({ onAcceptance: 'notify', notifyEmail: false, notifySms: true, notifyPush: false })).toEqual({ onAcceptance: 'notify', notifyEmail: false, notifySms: true, notifyPush: false });
  });

  it('knows four modes, and never makes a cash sale on its own', () => {
    for (const m of ['notify', 'sales_order', 'sales_invoice', 'credit_sale']) expect(isAcceptanceMode(m)).toBe(true);
    expect(isAcceptanceMode('cash_sale')).toBe(false);
  });

  it('checks what the screen sent', () => {
    expect(checkAcceptance({ onAcceptance: 'credit_sale', notifyEmail: true, notifySms: false, notifyPush: true })).toEqual({ ok: true, settings: { onAcceptance: 'credit_sale', notifyEmail: true, notifySms: false, notifyPush: true } });
    expect(checkAcceptance({ onAcceptance: 'cash_sale', notifyEmail: true, notifySms: true, notifyPush: true })).toMatchObject({ ok: false });
    expect(checkAcceptance({ onAcceptance: 'notify', notifyEmail: 'true', notifySms: true, notifyPush: true })).toMatchObject({ ok: false });
    expect(checkAcceptance(null)).toMatchObject({ ok: false });
  });
});

describe('what staff are told', () => {
  it('says what was made, with its numbers, and that nothing is needed', () => {
    const s = acceptanceSentences({ ...base, outcome: { kind: 'converted', target: 'sales_invoice', number: 'ORD-1', invoiceNumber: 'INV-9', waitingForApproval: false } });
    expect(s.what).toContain('sales invoice ORD-1');
    expect(s.what).toContain('tax invoice is INV-9');
    expect(s.next).toMatch(/Nothing is needed/);
  });

  it('asks for approval when the order waits, and for a person when it could not be made', () => {
    expect(acceptanceSentences({ ...base, outcome: { kind: 'converted', target: 'sales_order', number: 'ORD-2', invoiceNumber: null, waitingForApproval: true } }).next).toMatch(/Approve it/);
    const failed = acceptanceSentences({ ...base, outcome: { kind: 'failed', target: 'credit_sale', reason: 'Acme is a cash customer.' } });
    expect(failed.what).toContain('could not be made into credit sale automatically: Acme is a cash customer.');
    expect(failed.next).toMatch(/convert it yourself/);
    expect(acceptanceSentences({ ...base, outcome: { kind: 'waiting' } }).next).toMatch(/choose what it becomes/);
  });

  it('makes one notice for every channel, marks the ones that need action, and escapes the name in the mail', () => {
    const waiting = acceptanceNotice({ ...base, outcome: { kind: 'waiting' } });
    expect(waiting.subject).toBe('Acme <Ltd> accepted quotation QTE-7: action needed');
    expect(waiting.html).toContain('Acme &lt;Ltd&gt;');
    expect(waiting.html).not.toContain('<Ltd>');
    expect(waiting.html).toContain('href="https://shop.test/admin/quotes"');
    expect(waiting.sms).toBe('Bigbro: Acme <Ltd> accepted QTE-7 (KES 12,400.00). Needs your action.');
    expect(waiting.push).toMatchObject({ title: 'Quote accepted: action needed', url: '/admin/quotes', tag: 'quote-accepted-QTE-7' });
    const done = acceptanceNotice({ ...base, outcome: { kind: 'converted', target: 'sales_order', number: 'ORD-1', invoiceNumber: null, waitingForApproval: false } });
    expect(done.subject).not.toContain('action needed');
    expect(done.sms).not.toContain('Needs your action');
    expect(done.push.title).toBe('Quote accepted');
  });

  it('leaves out the link when the site\'s address is not known, and keeps a text message short', () => {
    const n = acceptanceNotice({ ...base, link: '', customerName: 'N'.repeat(500), outcome: { kind: 'waiting' } });
    expect(n.html).not.toContain('<a ');
    expect(n.text).not.toContain('Open the quote:');
    expect(n.sms.length).toBeLessThanOrEqual(300);
  });
});
