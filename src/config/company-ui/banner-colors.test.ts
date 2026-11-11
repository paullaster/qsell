import { describe, expect, it } from 'vitest';
import { bannerColor, contrastRatio, isReadable, readableTextOn, textColorFor } from './banner-colors';
import { bannerLook } from '@/lib/banner-look';

describe('banner colours', () => {
  it('accepts hex colours only and writes them in full', () => {
    expect(bannerColor('#F00')).toBe('#ff0000');
    expect(bannerColor('#1D4ED8')).toBe('#1d4ed8');
    for (const bad of ['red', 'rgb(1,2,3)', '#12', 'url(x)', '', 5, null]) expect(bannerColor(bad)).toBe('');
  });
  it('measures contrast from 1 to 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
  it('picks dark or white text, whichever reads better', () => {
    expect(readableTextOn('#facc15')).toBe('#111827');
    expect(readableTextOn('#111827')).toBe('#ffffff');
    for (const bg of ['#dc2626', '#facc15', '#1d4ed8', '#15803d', '#ffffff', '#000000', '#808080', '#777777', '#6b7280', '#757575']) expect(isReadable(readableTextOn(bg), bg)).toBe(true);
  });
  it('keeps a chosen text colour when it can be read and replaces it when it cannot', () => {
    expect(textColorFor('#111827', '#fde047')).toBe('#fde047');
    expect(textColorFor('#facc15', '#fde047')).toBe('#111827');
    expect(textColorFor('#1d4ed8', '')).toBe('#ffffff');
    expect(textColorFor('', '#ffffff')).toBe('');
  });
  it('draws the shop look by default and readable colours otherwise', () => {
    expect(bannerLook({ background: '', textColor: '', speed: 'normal' })).toMatchObject({ custom: false, style: {} });
    const look = bannerLook({ background: '#facc15', textColor: '#fde047', speed: 'fast' });
    expect(look).toMatchObject({ custom: true, seconds: 14, style: { backgroundColor: '#facc15', color: '#111827' } });
  });
});
