import { describe, expect, it } from 'vitest';
import { branchPayload, emptyBranchForm, pinFormFor } from './branch-forms';

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

describe('pinFormFor', () => {
  it('is empty for a branch with no pin, and shows the numbers and label of one that has', () => {
    expect(pinFormFor(null)).toEqual({ latitude: '', longitude: '', label: '' });
    expect(pinFormFor({ latitude: -1.286389, longitude: 36.817223, label: 'Shop front' })).toEqual({ latitude: '-1.286389', longitude: '36.817223', label: 'Shop front' });
    expect(pinFormFor({ latitude: 0, longitude: 0, label: null })).toEqual({ latitude: '0', longitude: '0', label: '' });
  });
});
