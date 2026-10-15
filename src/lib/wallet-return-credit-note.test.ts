import { describe, expect, it } from 'vitest';
import { AUTO_APPLY_MODES, describePolicy, inForce, policyInput, startingForm, type PolicyRow } from './wallet-policy';
import { canUndoUse, entryLabel, fillFromWallet, invoicesIn } from './wallet-panel';
import { blankEntries, confirmedMessage, confirmItems, conditionLabel, nothingTyped } from './return-form';
import { anythingLeft, creditEstimate, chosenLines, creditNoteRequest, noteMissing, reasonLabel, round2 } from './credit-note-form';

const row = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  groupCode: null, effectiveFrom: '2026-01-01', walletEnabled: true, allowDeposits: true, overpaymentDefault: 'wallet', autoApply: 'never', creditNoteExcess: 'ask',
  refundsEnabled: true, walletCashOut: false, maxBalance: null, label: 'Wallet', ...over,
});

describe('wallet policy', () => {
  it('uses the newest rule that has started, per scope', () => {
    const rows = [row({ effectiveFrom: '2026-01-01', label: 'Old' }), row({ effectiveFrom: '2026-06-01', label: 'New' }), row({ effectiveFrom: '2027-01-01', label: 'Future' }), row({ groupCode: 'VIP', label: 'VIP' })];
    const force = inForce(rows, '2026-10-15');
    expect(force.get('')?.label).toBe('New');
    expect(force.get('VIP')?.label).toBe('VIP');
    expect(force.size).toBe(2);
  });

  it('describes a rule in words', () => {
    expect(describePolicy(undefined)).toContain('Not set');
    expect(describePolicy(row({ walletEnabled: false }))).toBe('Off.');
    expect(describePolicy(row({ autoApply: 'oldest_first', allowDeposits: false, maxBalance: '5000' }))).toBe('On. Overpayments: put it in the wallet. Paid from automatically on credit invoices. No advance deposits. Holds at most 5000.');
  });

  it('starts the form from the scope’s rule, else the business’s, else safe defaults, and sends an empty limit as null', () => {
    expect(startingForm(null, undefined, undefined)).toMatchObject({ walletEnabled: false, overpaymentDefault: 'ask', label: 'Wallet' });
    const company = row({ label: 'Credit', maxBalance: '10' });
    expect(startingForm('VIP', undefined, company)).toMatchObject({ groupCode: 'VIP', walletEnabled: true, label: 'Credit', maxBalance: '10' });
    expect(policyInput({ ...startingForm(null, company, company), maxBalance: ' ' }).maxBalance).toBeNull();
    expect(AUTO_APPLY_MODES).toHaveLength(2);
  });
});

describe('wallet panel', () => {
  it('labels movements and lets a use be undone once', () => {
    expect(entryLabel('deposit')).toBe('Advance deposit');
    expect(entryLabel('odd')).toBe('odd');
    const use = { id: 7, type: 'utilisation', sourceType: null, sourceId: null };
    const back = { id: 8, type: 'reversal', sourceType: 'wallet_entry', sourceId: '7' };
    expect(canUndoUse([use], use, true)).toBe(true);
    expect(canUndoUse([use], use, false)).toBe(false);
    expect(canUndoUse([use, back], use, true)).toBe(false);
    expect(canUndoUse([use], { ...use, type: 'deposit' }, true)).toBe(false);
  });

  it('fills the open invoices of one currency oldest first', () => {
    const open = [{ entryId: 'a', remaining: '30.00', currency: 'KES' }, { entryId: 'b', remaining: '5.00', currency: 'USD' }, { entryId: 'c', remaining: '50.00', currency: 'KES' }];
    expect(invoicesIn(open, 'KES').map((i) => i.entryId)).toEqual(['a', 'c']);
    expect(fillFromWallet(open, 'KES', '40.00')).toEqual({ a: '30.00', c: '10.00' });
  });
});

describe('returns', () => {
  it('sends only the lines with a quantity, with condition and disposition', () => {
    const entries = blankEntries(['l1', 'l2'], 'quarantine');
    expect(nothingTyped(['l1', 'l2'], entries)).toBe(true);
    entries.l1 = { ...entries.l1, qty: '3', note: ' dented ' };
    entries.l2 = { ...entries.l2, qty: 'x' };
    expect(confirmItems(['l1', 'l2'], entries)).toEqual([{ lineId: 'l1', quantity: 3, condition: 'good', disposition: 'quarantine', note: 'dented' }]);
    expect(conditionLabel('wrong_item')).toBe('Wrong item');
    expect(confirmedMessage(0)).toBe('Confirmed. Nothing was added to stock.');
    expect(confirmedMessage(1)).toBe('Confirmed. 1 unit added to stock.');
    expect(confirmedMessage(4)).toBe('Confirmed. 4 units added to stock.');
  });
});

describe('credit note form', () => {
  const lines = [
    { productId: 'p1', unitPrice: 3.33, remainingQuantity: 3, remainingAmount: 10 },
    { productId: 'p2', unitPrice: 5, remainingQuantity: 2, remainingAmount: 10 },
  ];
  it('prices the chosen lines as the server does: the last unit takes what is left', () => {
    const chosen = chosenLines(lines, { p1: '3', p2: '1.9' });
    expect(chosen.map((c) => c.quantity)).toEqual([3, 1]);
    expect(creditEstimate(chosen)).toBe(15);
    expect(creditEstimate(chosenLines(lines, { p1: '2' }))).toBe(round2(3.33 * 2));
    expect(chosenLines(lines, { p1: '0', p2: '' })).toEqual([]);
  });

  it('knows what is left, when a note is required and the words of a reason', () => {
    expect(anythingLeft(lines)).toBe(true);
    expect(anythingLeft([{ ...lines[0], remainingQuantity: 0 }])).toBe(false);
    expect(noteMissing('other', ' ')).toBe(true);
    expect(noteMissing('other', 'x')).toBe(false);
    expect(noteMissing('goodwill', '')).toBe(false);
    expect(reasonLabel('goodwill')).toBe('Goodwill');
    expect(reasonLabel('zzz')).toBe('zzz');
  });

  it('builds the request, restocking only when the order allows it', () => {
    const chosen = chosenLines(lines, { p1: '1' });
    expect(creditNoteRequest('o1', chosen, 'goodwill', ' ', true, false)).toEqual({ orderId: 'o1', lines: [{ productId: 'p1', quantity: 1 }], reasonCode: 'goodwill', reasonNote: undefined, restock: false });
    expect(creditNoteRequest('o1', chosen, 'other', ' why ', true, true)).toMatchObject({ reasonNote: 'why', restock: true });
  });
});
