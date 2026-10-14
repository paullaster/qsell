import { describe, expect, it } from 'vitest';
import { approvalNote, missesMarginFloor, money, quoteBadge, rowActions } from './quote-display';

const base = {
  status: 'draft',
  approvalStatus: 'not_required',
  expired: false,
  grossMarginPercent: '30',
  minimumMarginPercent: '10',
};

describe('quote display rules', () => {
  it('formats money with separators and two decimals', () => {
    expect(money(1234.5, 'KES')).toMatch(/^KES 1.234\.50$/);
    expect(money(0, 'USD')).toBe('USD 0.00');
  });

  it('compares the margin with the floor, from numbers or numeric strings', () => {
    expect(missesMarginFloor({ grossMarginPercent: '9.9', minimumMarginPercent: '10' })).toBe(true);
    expect(missesMarginFloor({ grossMarginPercent: 10, minimumMarginPercent: '10' })).toBe(false);
  });

  it('words and colours the status badge', () => {
    expect(quoteBadge(base)).toEqual({ label: 'draft', tone: 'neutral', waitingOnMargin: false });
    expect(quoteBadge({ ...base, status: 'pending_approval', expired: false }).label).toBe(
      'pending approval',
    );
    expect(quoteBadge({ ...base, status: 'accepted' }).tone).toBe('success');
    expect(quoteBadge({ ...base, status: 'converted' }).tone).toBe('success');
    for (const status of ['rejected', 'expired', 'cancelled']) {
      expect(quoteBadge({ ...base, status }).tone).toBe('danger');
    }
    expect(quoteBadge({ ...base, status: 'sent', expired: true })).toMatchObject({
      label: 'expired',
    });
  });

  it('flags a quote held on its margin as a warning, whatever its status words', () => {
    const held = quoteBadge({
      ...base,
      status: 'pending_approval',
      approvalStatus: 'pending',
      grossMarginPercent: '2',
    });
    expect(held).toMatchObject({ tone: 'warning', waitingOnMargin: true });
  });

  it('adds an approval note only when a workflow owns the quote', () => {
    expect(approvalNote({ approvalManagedBy: null, approvalStatus: 'pending' })).toBeNull();
    expect(approvalNote({ approvalManagedBy: 'workflow', approvalStatus: 'pending' })).toMatch(
      /Waiting/,
    );
    expect(approvalNote({ approvalManagedBy: 'workflow', approvalStatus: 'rejected' })).toMatch(
      /refused/,
    );
    expect(approvalNote({ approvalManagedBy: 'workflow', approvalStatus: 'draft' })).toMatch(
      /Reopened/,
    );
    expect(approvalNote({ approvalManagedBy: 'workflow', approvalStatus: 'approved' })).toBeNull();
  });

  describe('which actions a row offers', () => {
    const quote = {
      status: 'draft',
      approvalStatus: 'not_required',
      approvalManagedBy: null,
      customerEmail: 'a@b.test',
    };
    const all = { canCreate: true, canUpdate: true, canApprove: true };
    const none = { canCreate: false, canUpdate: false, canApprove: false };

    it('offers nothing to someone who may do nothing', () => {
      expect(rowActions(quote, none)).toMatchObject({
        template: false,
        edit: false,
        approve: false,
        email: false,
        convert: false,
      });
    });

    it('lets a draft be edited and emailed, but not approved or converted', () => {
      expect(rowActions(quote, all)).toMatchObject({
        edit: true,
        email: true,
        approve: false,
        convert: false,
        template: true,
      });
    });

    it('does not offer email while an approval is pending, refused or reopened', () => {
      for (const approvalStatus of ['pending', 'rejected', 'draft']) {
        expect(rowActions({ ...quote, approvalStatus }, all).email).toBe(false);
      }
    });

    it('offers approve only for a quote waiting without a workflow, and convert for accepted', () => {
      const waiting = { ...quote, status: 'pending_approval' };
      expect(rowActions(waiting, all)).toMatchObject({ approve: true, edit: true, email: false });
      expect(rowActions({ ...waiting, approvalManagedBy: 'workflow' }, all).approve).toBe(false);
      expect(rowActions({ ...quote, status: 'accepted' }, all)).toMatchObject({
        convert: true,
        edit: false,
      });
    });

    it('flags a missing email only while the quote could still be sent', () => {
      expect(rowActions({ ...quote, customerEmail: null }, all).missingEmail).toBe(true);
      expect(rowActions({ ...quote, customerEmail: '' }, all).missingEmail).toBe(true);
      expect(rowActions({ ...quote, customerEmail: null, status: 'sent' }, all).missingEmail).toBe(
        false,
      );
    });
  });
});

describe('showing text only when there is some', () => {
  it('knows blank from present', async () => {
    const { hasText } = await import('./quote-display');
    for (const blank of [null, undefined, '', '   ']) expect(hasText(blank)).toBe(false);
    expect(hasText(' a ')).toBe(true);
  });
  it('joins the parts that have text', async () => {
    const { joinPresent, orElse } = await import('./quote-display');
    expect(joinPresent(['1 Road', null, '', 'Nairobi', ' '], ', ')).toBe('1 Road, Nairobi');
    expect(joinPresent([null, ''], ', ')).toBe('');
    expect(orElse('', 'none')).toBe('none');
    expect(orElse('x', 'none')).toBe('x');
  });
});
