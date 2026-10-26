import { describe, expect, it } from 'vitest';
import { activeBanners, resolveBanners, safeBannerHref } from './banners';
import { resolveCompanyUiConfig } from './resolve';

describe('safeBannerHref', () => {
  it('keeps shop pages and http(s) addresses only', () => {
    expect(safeBannerHref('/?category=shoes')).toBe('/?category=shoes');
    expect(safeBannerHref('https://example.com/sale')).toBe('https://example.com/sale');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', '/\\evil.test', 'ftp://x.test', 'not a url', '']) expect(safeBannerHref(bad)).toBe('');
  });
});

describe('resolveBanners', () => {
  it('drops banners with no title and gives a button only when there is a place to go', () => {
    const banners = resolveBanners([{ title: 'Sale', href: '/' }, { title: '', text: 'x' }, { title: 'Closed', text: 'We close on Friday.' }, 'junk']);
    expect(banners).toHaveLength(2);
    expect(banners[0]).toMatchObject({ title: 'Sale', cta: 'Shop now', active: true });
    expect(banners[1]).toMatchObject({ href: '', cta: '' });
  });
  it('ignores impossible dates and a closing day before the opening day', () => {
    const [banner] = resolveBanners([{ title: 'T', startsOn: '2031-02-30', endsOn: 'soon' }]);
    expect(banner).toMatchObject({ startsOn: '', endsOn: '' });
    expect(resolveBanners([{ title: 'T', startsOn: '2031-05-10', endsOn: '2031-05-01' }])[0]?.endsOn).toBe('');
  });
  it('keeps five at most and is part of the company look', () => {
    expect(resolveBanners(Array.from({ length: 9 }, (_, i) => ({ title: `B${String(i)}` })))).toHaveLength(5);
    expect(resolveCompanyUiConfig(null).banners).toEqual([]);
  });
});

describe('activeBanners', () => {
  const [open, windowed, off] = resolveBanners([{ title: 'Always' }, { title: 'May', startsOn: '2031-05-01', endsOn: '2031-05-31' }, { title: 'Off', active: false }]);
  it('shows a banner inside its days, including both ends, and never a switched-off one', () => {
    for (const today of ['2031-05-01', '2031-05-31', '2031-05-15']) expect(activeBanners([open, windowed, off].filter((b) => b !== undefined), today).map((b) => b.title)).toEqual(['Always', 'May']);
    expect(activeBanners([open, windowed].filter((b) => b !== undefined), '2031-04-30').map((b) => b.title)).toEqual(['Always']);
    expect(activeBanners([open, windowed].filter((b) => b !== undefined), '2031-06-01').map((b) => b.title)).toEqual(['Always']);
  });
});
