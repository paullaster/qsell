import { describe, expect, it } from 'vitest';
import {
  PLAIN_HEADING,
  STANDARD_LETTERHEAD,
  brandBlock,
  headingFor,
  readShow,
  resolveRecordPrint,
  resolveReportPrint,
  showProblem,
  type BrandProfile,
} from './print-branding';

const profile: BrandProfile = {
  tradingName: 'SM Engineering',
  legalName: 'SM Engineering Limited',
  tagline: 'Solar, done properly',
  streetAddress: 'Mombasa Road',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  postalCode: '00100',
  country: 'Kenya',
  email: 'info@sm.example',
  phone: '0712 345 678',
  tel: '020 123 4567',
  website: 'sm.example',
  kraPin: 'P051234567X',
  logoUrl: '/api/company/logo/logo-1.png',
};

describe('what a printed heading carries', () => {
  it('shows only the name until something is chosen', () => {
    expect(brandBlock(profile, PLAIN_HEADING)).toEqual({
      name: 'SM Engineering',
      legalName: null,
      tagline: null,
      address: null,
      contacts: [],
      kraPin: null,
      logoUrl: null,
    });
  });

  it('builds the standard letterhead from what the business entered', () => {
    const block = brandBlock(profile, STANDARD_LETTERHEAD);
    expect(block.legalName).toBe('SM Engineering Limited');
    expect(block.address).toBe('Mombasa Road, Nairobi, Nairobi 00100, Kenya');
    expect(block.contacts).toEqual(['Tel 0712 345 678 / 020 123 4567', 'info@sm.example']);
    expect(block.logoUrl).toBe('/api/company/logo/logo-1.png');
    expect(block.kraPin).toBeNull();
  });

  it('leaves out what the business has not entered and does not repeat the name', () => {
    const block = brandBlock(
      { ...profile, legalName: 'SM Engineering', tel: '', email: '', logoUrl: null },
      { ...STANDARD_LETTERHEAD, website: true },
    );
    expect(block.legalName).toBeNull();
    expect(block.contacts).toEqual(['Tel 0712 345 678', 'sm.example']);
    expect(block.logoUrl).toBeNull();
  });

  it('prints the same number once when phone and telephone are the same', () => {
    expect(brandBlock({ ...profile, tel: profile.phone }, STANDARD_LETTERHEAD).contacts[0]).toBe(
      'Tel 0712 345 678',
    );
  });

  it('serves a logo saved in the old upload folder through the logo route', () => {
    expect(
      brandBlock({ ...profile, logoUrl: '/uploads/company/logo-abc.png' }, STANDARD_LETTERHEAD).logoUrl,
    ).toBe('/api/company/logo/logo-abc.png');
  });

  it('falls back to the registered name when there is no trading name', () => {
    expect(brandBlock({ ...profile, tradingName: ' ' }, PLAIN_HEADING).name).toBe(
      'SM Engineering Limited',
    );
  });
});

describe('stored heading settings', () => {
  it('starts with nothing shown', () => {
    expect(resolveReportPrint(undefined, ['sales'])).toEqual({ general: PLAIN_HEADING, modules: {} });
    expect(resolveRecordPrint(null).cash_sale).toEqual(PLAIN_HEADING);
  });

  it('keeps a module heading only for modules that exist, and falls back to the general one', () => {
    const settings = resolveReportPrint(
      {
        general: { logo: true },
        modules: { sales: { email: true }, nothing: { logo: true }, finance: 'bad' },
      },
      ['sales', 'finance'],
    );
    expect(Object.keys(settings.modules)).toEqual(['sales']);
    expect(headingFor(settings, 'sales').email).toBe(true);
    expect(headingFor(settings, 'sales').logo).toBe(false);
    expect(headingFor(settings, 'finance').logo).toBe(true);
  });

  it('ignores a choice that is not a true or false answer', () => {
    expect(readShow({ logo: 'yes', email: true }).logo).toBe(false);
    expect(readShow({ logo: 'yes', email: true }).email).toBe(true);
  });

  it('refuses a set of choices with a part missing or not true or false', () => {
    expect(showProblem(STANDARD_LETTERHEAD)).toBeNull();
    expect(showProblem({ ...STANDARD_LETTERHEAD, logo: 'yes' })).toMatch(/logo/);
    expect(showProblem(null)).not.toBeNull();
  });
});
