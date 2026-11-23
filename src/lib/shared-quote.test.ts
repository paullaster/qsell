import { describe, expect, it } from 'vitest';
import { sharedStateOf } from './shared-quote';

describe('what a customer\'s quote link shows', () => {
  it('waits for an answer only while the quote is sent', () => {
    expect(sharedStateOf('sent')).toBe('open');
  });

  it('says accepted for every state an accepted quote passes through, so the link never goes missing after acceptance', () => {
    for (const status of ['accepted', 'converting', 'converted']) expect(sharedStateOf(status)).toBe('accepted');
  });

  it('says declined, expired, or no longer available for the rest', () => {
    expect(sharedStateOf('rejected')).toBe('rejected');
    expect(sharedStateOf('expired')).toBe('expired');
    for (const status of ['draft', 'pending_approval', 'approved', 'cancelled', 'anything-else']) expect(sharedStateOf(status)).toBe('closed');
  });
});
