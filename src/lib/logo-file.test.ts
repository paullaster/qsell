import { describe, expect, it } from 'vitest';
import { detectLogoKind } from './logo-file';

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => new TextEncoder().encode(s);

describe('detecting a logo picture', () => {
  it('knows PNG, JPEG and WebP by their first bytes, whatever the name says', () => {
    expect(detectLogoKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(detectLogoKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpg');
    expect(detectLogoKind(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe('webp');
  });

  it('accepts a plain SVG, with or without the XML line', () => {
    expect(detectLogoKind(text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'))).toBe('svg');
    expect(detectLogoKind(text('﻿<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'))).toBe('svg');
  });

  it('refuses an SVG that carries anything that runs', () => {
    expect(detectLogoKind(text('<svg><script>alert(1)</script></svg>'))).toBeNull();
    expect(detectLogoKind(text('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(detectLogoKind(text('<svg><a href="javascript:alert(1)"/></svg>'))).toBeNull();
    expect(detectLogoKind(text('<svg><foreignObject><div/></foreignObject></svg>'))).toBeNull();
    expect(detectLogoKind(text('<svg><image xlink:href="https://evil.test/x.png"/></svg>'))).toBeNull();
  });

  it('refuses everything else, however it is named', () => {
    expect(detectLogoKind(text('<html><body>hi</body></html>'))).toBeNull();
    expect(detectLogoKind(text('GIF89a'))).toBeNull();
    expect(detectLogoKind(bytes())).toBeNull();
    expect(detectLogoKind(text('MZ\u0090 executable'))).toBeNull();
  });
});
