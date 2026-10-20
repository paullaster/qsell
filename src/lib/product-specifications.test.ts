import { describe, expect, it } from 'vitest';
import { visibleSpecifications } from './product-specifications';

describe('specifications shown to shoppers', () => {
  it('keeps rows with a name and a value, trimmed, in order', () => {
    expect(
      visibleSpecifications([
        { key: ' Colour ', value: ' Red ' },
        { key: 'Weight', value: '2 kg' },
      ]),
    ).toEqual([
      { key: 'Colour', value: 'Red' },
      { key: 'Weight', value: '2 kg' },
    ]);
  });

  it('drops half-filled rows, and copes with none', () => {
    expect(
      visibleSpecifications([
        { key: 'Colour', value: ' ' },
        { key: '', value: 'x' },
      ]),
    ).toEqual([]);
    expect(visibleSpecifications(undefined)).toEqual([]);
  });
});
