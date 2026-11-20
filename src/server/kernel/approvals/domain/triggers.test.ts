import { describe, expect, it } from 'vitest';
import { TRIGGERS } from './triggers';

describe('approval triggers', () => {
  it('registers the customer credit setting once with the fields an approver needs', () => {
    const matches = TRIGGERS.filter((t) => t.code === 'customer_credit_settings.enable_over_limit');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ module: 'sales', documentKind: 'customer_credit_settings' });
    expect(matches[0]?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(['amount', 'requestedBy', 'allowOverCreditLimit']),
    );
  });

  it('does not reuse an approval document kind for another trigger', () => {
    const kinds = TRIGGERS.map((t) => t.documentKind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
