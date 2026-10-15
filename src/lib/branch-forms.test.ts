import { describe, expect, it } from 'vitest';
import { branchPayload, emptyBranchForm } from './branch-forms';

describe('branchPayload', () => {
  it('keeps codes in capitals and trims names', () => {
    expect(branchPayload({ code: ' nbo ', name: '  Nairobi  ', actsIndependently: true })).toEqual({ ok: true, payload: { code: 'NBO', name: 'Nairobi', actsIndependently: true } });
  });
  it('needs a code and a name', () => {
    expect(branchPayload(emptyBranchForm())).toMatchObject({ ok: false });
    expect(branchPayload({ code: 'A', name: ' ', actsIndependently: false })).toMatchObject({ ok: false });
  });
  it('refuses a code that cannot be a code', () => {
    expect(branchPayload({ code: 'bad code!', name: 'x', actsIndependently: false })).toMatchObject({ ok: false });
    expect(branchPayload({ code: 'A'.repeat(21), name: 'x', actsIndependently: false })).toMatchObject({ ok: false });
  });
});
