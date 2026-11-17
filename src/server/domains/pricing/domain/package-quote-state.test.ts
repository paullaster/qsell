import { describe, expect, it } from 'vitest';
import { QUOTE_REQUEST_STATE_WORDS, quoteRequestState } from './package-quote-state';

describe('where a requested quote stands', () => {
  it('reads each staff status in the shopper\'s words', () => {
    expect(['draft', 'pending_approval', 'approved'].map(quoteRequestState)).toEqual(['preparing', 'preparing', 'preparing']);
    expect(quoteRequestState('sent')).toBe('sent');
    expect(['accepted', 'converting', 'converted'].map(quoteRequestState)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(quoteRequestState('rejected')).toBe('declined');
    expect(quoteRequestState('expired')).toBe('expired');
    expect(quoteRequestState('cancelled')).toBe('cancelled');
  });

  it('never promises more than it knows: an unknown status is still being prepared', () => {
    expect(quoteRequestState('something_new')).toBe('preparing');
  });

  it('has words for every state', () => {
    for (const state of ['preparing', 'sent', 'accepted', 'declined', 'expired', 'cancelled'] as const) expect(QUOTE_REQUEST_STATE_WORDS[state].label).not.toBe('');
  });
});
