import { describe, expect, it } from 'vitest';
import { GOOD_ENOUGH_M, accuracyNote } from './geo-accuracy';

describe('how sure the device is of the place', () => {
  it('says nothing when the place is precise or the device did not say', () => {
    expect(accuracyNote(null)).toBeNull();
    expect(accuracyNote(undefined)).toBeNull();
    expect(accuracyNote(Number.NaN)).toBeNull();
    expect(accuracyNote(5)).toBeNull();
    expect(accuracyNote(GOOD_ENOUGH_M)).toBeNull();
  });
  it('says how far out it may be, in metres below a kilometre and in kilometres above, and what to do', () => {
    expect(accuracyNote(GOOD_ENOUGH_M + 1)).toContain('within about 200 m');
    expect(accuracyNote(347)).toContain('within about 350 m');
    expect(accuracyNote(2400)).toContain('within about 2.4 km');
    expect(accuracyNote(18500)).toContain('within about 18.5 km');
    expect(accuracyNote(2400)).toContain('Drag the pin to your door');
  });
});
