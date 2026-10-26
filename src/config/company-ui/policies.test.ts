import { nth } from '@/lib/values';
import { describe, expect, it } from 'vitest';
import { parsePolicyBody, policyAddress, policySlug, resolvePolicies } from './policies';
import { resolveCompanyUiConfig } from './resolve';

describe('policySlug', () => {
  it('makes an address part from a title', () => {
    expect(policySlug('  Returns & Refunds! ')).toBe('returns-refunds');
    expect(policySlug('Déjà vu')).toBe('deja-vu');
    expect(policySlug('???')).toBe('');
  });
});

describe('resolvePolicies', () => {
  it('keeps complete pages and drops the rest', () => {
    const pages = resolvePolicies([
      { id: 'a', title: 'Privacy', body: 'We keep your data safe.' },
      { title: '', body: 'No title' },
      { title: 'No body', body: '  ' },
      'junk',
      null,
    ]);
    expect(pages).toEqual([{ id: 'a', slug: 'privacy', title: 'Privacy', body: 'We keep your data safe.' }]);
  });

  it('never gives two pages the same address, and ignores a bad given address', () => {
    const pages = resolvePolicies([
      { title: 'Terms', body: 'x' },
      { title: 'Terms', body: 'y' },
      { title: 'Shipping', slug: '../../admin', body: 'z' },
    ]);
    expect(pages.map((p) => p.slug)).toEqual(['terms', 'terms-2', 'admin']);
    expect(policyAddress(nth(pages, 0))).toBe('/policies/terms');
  });

  it('caps the number of pages and gives nothing for anything but a list', () => {
    expect(resolvePolicies(Array.from({ length: 30 }, (_, i) => ({ title: `P${String(i)}`, body: 'x' })))).toHaveLength(12);
    expect(resolvePolicies({})).toEqual([]);
    expect(resolvePolicies(undefined)).toEqual([]);
  });

  it('is part of the company look, empty by default', () => {
    expect(resolveCompanyUiConfig(null).policies).toEqual([]);
    expect(resolveCompanyUiConfig({ policies: [{ title: 'Returns', body: 'b' }] }).policies).toHaveLength(1);
  });
});

describe('parsePolicyBody', () => {
  it('reads headings, paragraphs and lists', () => {
    expect(parsePolicyBody('# Returns\n\nYou may return items\nwithin 14 days.\n\n- Unused\n- In the box\n\nContact us.')).toEqual([
      { kind: 'heading', text: 'Returns' },
      { kind: 'paragraph', text: 'You may return items within 14 days.' },
      { kind: 'list', items: ['Unused', 'In the box'] },
      { kind: 'paragraph', text: 'Contact us.' },
    ]);
  });

  it('keeps markup as plain text', () => {
    expect(parsePolicyBody('<script>alert(1)</script>')).toEqual([{ kind: 'paragraph', text: '<script>alert(1)</script>' }]);
  });

  it('handles Windows line endings and empty input', () => {
    expect(parsePolicyBody('A\r\n\r\nB')).toEqual([{ kind: 'paragraph', text: 'A' }, { kind: 'paragraph', text: 'B' }]);
    expect(parsePolicyBody('')).toEqual([]);
  });
});
