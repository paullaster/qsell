import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  categoricalVar,
  colorSlotFor,
  contrast,
  deltaE,
  hexToRgb,
  luminance,
  simulate,
  type Deficiency,
  type Theme,
} from './palette';

const THEMES: Theme[] = ['light', 'dark'];
const KINDS: Deficiency[] = ['protanopia', 'deuteranopia', 'tritanopia'];

describe('colour maths', () => {
  it('knows black, white and the contrast between them', () => {
    expect(luminance(hexToRgb('#000000'))).toBe(0);
    expect(luminance(hexToRgb('#ffffff'))).toBeCloseTo(1, 6);
    expect(contrast(hexToRgb('#000000'), hexToRgb('#ffffff'))).toBeCloseTo(21, 4);
    expect(contrast(hexToRgb('#ffffff'), hexToRgb('#ffffff'))).toBe(1);
  });

  it('refuses a colour that is not six hex digits', () => {
    expect(() => hexToRgb('#fff')).toThrow();
    expect(() => hexToRgb('blue')).toThrow();
  });

  it('measures how different two colours look', () => {
    const a = hexToRgb('#0072b2');
    expect(deltaE(a, a)).toBe(0);
    expect(deltaE(hexToRgb('#ffffff'), hexToRgb('#000000'))).toBeCloseTo(100, 0);
    expect(deltaE(hexToRgb('#d55e00'), hexToRgb('#0072b2'))).toBeGreaterThan(40);
  });

  it('turns red and green into near neighbours for red-green colour blindness', () => {
    const red = hexToRgb('#d55e00');
    const green = hexToRgb('#2a9d3f');
    expect(deltaE(simulate(red, 'deuteranopia'), simulate(green, 'deuteranopia'))).toBeLessThan(
      deltaE(red, green),
    );
  });
});

describe('the data palette', () => {
  it('has eight categorical colours and five-step ramps in each theme', () => {
    for (const t of THEMES) {
      expect(PALETTE[t].categorical).toHaveLength(8);
      expect(PALETTE[t].sequential).toHaveLength(5);
      expect(PALETTE[t].diverging).toHaveLength(5);
    }
  });

  it('keeps every categorical colour at 3:1 or better against the surfaces it is drawn on', () => {
    for (const t of THEMES) {
      for (const hex of PALETTE[t].categorical) {
        for (const surface of PALETTE[t].surfaces) {
          expect(
            contrast(hexToRgb(hex), hexToRgb(surface)),
            `${t} ${hex} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('keeps the strong end of a sequential ramp readable on the surface', () => {
    expect(
      contrast(hexToRgb(PALETTE.light.sequential[4] ?? '#000000'), hexToRgb('#ffffff')),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(hexToRgb(PALETTE.dark.sequential[4] ?? '#000000'), hexToRgb('#09090b')),
    ).toBeGreaterThanOrEqual(3);
  });

  it('steps a sequential ramp in one direction, so more always looks like more', () => {
    for (const t of THEMES) {
      const lums = PALETTE[t].sequential.map((h) => luminance(hexToRgb(h)));
      const sorted = [...lums].sort((a, b) => (t === 'light' ? b - a : a - b));
      expect(lums).toEqual(sorted);
    }
  });

  it('keeps all eight series clearly different from each other in every theme', () => {
    for (const t of THEMES) {
      const cols = PALETTE[t].categorical.map(hexToRgb);
      for (let i = 0; i < cols.length; i += 1) {
        for (let j = i + 1; j < cols.length; j += 1) {
          const [a, b] = [cols[i], cols[j]];
          if (a === undefined || b === undefined) continue;
          expect(
            deltaE(a, b),
            `${t} series ${String(i + 1)} and ${String(j + 1)}`,
          ).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('keeps the four series drawn together most often distinguishable under colour-vision deficiency', () => {
    for (const t of THEMES) {
      for (const kind of KINDS) {
        const cols = PALETTE[t].categorical.slice(0, 4).map((h) => simulate(hexToRgb(h), kind));
        for (let i = 0; i < cols.length; i += 1) {
          for (let j = i + 1; j < cols.length; j += 1) {
            const [a, b] = [cols[i], cols[j]];
            if (a === undefined || b === undefined) continue;
            expect(
              deltaE(a, b),
              `${t} ${kind} series ${String(i + 1)} and ${String(j + 1)}`,
            ).toBeGreaterThanOrEqual(12);
          }
        }
      }
    }
  });
});

describe('the CSS tokens match the palette', () => {
  const css = readFileSync(path.resolve(__dirname, '../../../../app/globals.css'), 'utf8');
  const block = (selector: string): string => {
    const start = css.indexOf(selector);
    const end = css.indexOf('\n}', start);
    return css.slice(start, end);
  };
  const light = block(':root {');
  const dark = block("[data-theme='dark'] {");
  const read = (text: string, name: string): string | undefined =>
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(text)?.[1]?.toLowerCase();

  it('defines every colour in both themes with the same value as the palette', () => {
    const groups: [keyof (typeof PALETTE)['light'], string][] = [
      ['categorical', 'data'],
      ['sequential', 'seq'],
      ['diverging', 'div'],
    ];
    for (const [theme, text] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const [family, prefix] of groups) {
        const hexes = PALETTE[theme][family] as readonly string[];
        hexes.forEach((hex, i) => {
          expect(
            read(text, `${prefix}-${String(i + 1)}`),
            `${theme} --${prefix}-${String(i + 1)}`,
          ).toBe(hex);
        });
      }
    }
  });
});

describe('stable colours for names', () => {
  it('gives the same slot to the same text, always', () => {
    expect(colorSlotFor('Mombasa')).toBe(colorSlotFor('Mombasa'));
    expect(colorSlotFor('')).toBeGreaterThanOrEqual(0);
  });

  it('stays inside the eight slots and spreads different names around', () => {
    const slots = new Set<number>();
    for (const name of [
      'Nairobi',
      'Mombasa',
      'Kisumu',
      'Nakuru',
      'Eldoret',
      'Nyeri',
      'Thika',
      'Malindi',
      'Kitale',
      'Garissa',
    ]) {
      const s = colorSlotFor(name);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(8);
      slots.add(s);
    }
    expect(slots.size).toBeGreaterThanOrEqual(4);
  });

  it('writes the CSS variable for a slot and wraps past eight', () => {
    expect(categoricalVar(0)).toBe('var(--data-1)');
    expect(categoricalVar(7)).toBe('var(--data-8)');
    expect(categoricalVar(8)).toBe('var(--data-1)');
  });
});
