import { describe, expect, it } from 'vitest';
import { resolveCompanyUiConfig, toCompanyUiConfigRaw } from './resolve';
import { hasSupportContent, resolveSupportConfig, supportChannelHref } from './support';

describe('resolveSupportConfig', () => {
  it('ships no content by default, only section names', () => {
    const s = resolveSupportConfig(undefined);
    expect(s.channels).toEqual([]);
    expect(s.guarantees).toEqual([]);
    expect(s.faqs).toEqual([]);
    expect(hasSupportContent(s)).toBe(false);
    expect(s.name).toBe('Help & Support');
  });

  it('honours custom names and falls back when blank', () => {
    const s = resolveSupportConfig({
      name: ' Concierge ',
      guaranteesTitle: '  ',
      faqsTitle: 'Q&A',
    });
    expect(s.name).toBe('Concierge');
    expect(s.guaranteesTitle).toBe('Our Customer Guarantees');
    expect(s.faqsTitle).toBe('Q&A');
  });

  it('drops incomplete rows and unsafe urls, and caps list sizes', () => {
    const s = resolveSupportConfig({
      channels: [
        { id: 'a', kind: 'location', value: 'Westlands', url: 'javascript:alert(1)' },
        { kind: 'bogus', value: 'x' },
        { kind: 'email', value: '' },
        ...Array.from({ length: 30 }, (_, i) => ({ kind: 'phone', value: `+2547000000${i}` })),
      ],
      faqs: [
        { question: 'Q', answer: '' },
        { question: 'Q2', answer: 'A2' },
      ],
      guarantees: [{ text: ' ' }, { text: 'Genuine' }],
    });
    expect(s.channels[0]).toMatchObject({ id: 'a', url: '' });
    expect(s.channels[1]?.kind).toBe('other');
    expect(s.channels).toHaveLength(12);
    expect(s.faqs).toHaveLength(1);
    expect(s.guarantees).toHaveLength(1);
  });

  it('round-trips through the company ui config', () => {
    const cfg = resolveCompanyUiConfig({ support: { faqs: [{ question: 'Q', answer: 'A' }] } });
    const again = resolveCompanyUiConfig(toCompanyUiConfigRaw(cfg));
    expect(again.support.faqs).toHaveLength(1);
  });
});

describe('supportChannelHref', () => {
  const ch = (kind: string, value: string, url = '') =>
    ({ id: '1', kind, label: '', value, detail: '', url }) as Parameters<
      typeof supportChannelHref
    >[0];
  it('builds links per kind', () => {
    expect(supportChannelHref(ch('phone', '+254 712 345 678'))).toBe('tel:+254712345678');
    expect(supportChannelHref(ch('whatsapp', '+254 712-345-678'))).toBe(
      'https://wa.me/254712345678',
    );
    expect(supportChannelHref(ch('email', 'a@b.co'))).toBe('mailto:a@b.co');
    expect(supportChannelHref(ch('email', 'not an email'))).toBeNull();
    expect(supportChannelHref(ch('location', 'Westlands'))).toBeNull();
    expect(supportChannelHref(ch('location', 'Westlands', 'https://maps.example/x'))).toBe(
      'https://maps.example/x',
    );
  });
});
