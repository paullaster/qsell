import { describe, expect, it } from 'vitest';
import { boxesOf, pinLabelFor } from './find-place';

describe('filling a map pin from a place found by name', () => {
  it('writes the point to six decimals, whatever the map service sent', () => {
    expect(boxesOf({ latitude: -1.2864, longitude: 36.8172 })).toEqual({ latitude: '-1.286400', longitude: '36.817200' });
    expect(boxesOf({ latitude: -1.28638912345, longitude: 36.81722399 })).toEqual({ latitude: '-1.286389', longitude: '36.817224' });
  });
  it('keeps a name the person already wrote, and otherwise uses the place found, kept to 120 characters', () => {
    expect(pinLabelFor('Shop front', 'Westlands, Nairobi')).toBe('Shop front');
    expect(pinLabelFor('  ', ' Westlands, Nairobi ')).toBe('Westlands, Nairobi');
    expect(pinLabelFor('', 'x'.repeat(200))).toHaveLength(120);
  });
});
