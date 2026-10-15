import { describe, expect, it } from 'vitest';
import { appearancePayload, moduleLabelsPayload, profilePayload, type ProfileForm } from './company-forms';

const good: ProfileForm = {
  legalName: ' Acme Ltd ', tradingName: 'Acme', tagline: '', email: ' Sales@Acme.CO.KE ', phone: '+254 700 000 000', tel: '', website: '',
  streetAddress: '1 Road', city: 'Nairobi', countyOrState: 'Nairobi', postalCode: '00100', country: 'Kenya', locationLabel: '',
  kraPin: 'p051234567z', vatNumber: '', registrationNumber: '', invoicePrefix: 'inv', invoiceFooterNote: '',
  bankName: '', bankBranch: '', bankAccountName: '', bankAccountNumber: '',
};
const errorOf = (over: Partial<ProfileForm>) => {
  const r = profilePayload({ ...good, ...over });
  return r.ok ? '' : r.error;
};

describe('company profile', () => {
  it('tidies a good form: trimmed names, lower-case email, capital PIN and prefix, empty boxes become nothing', () => {
    const r = profilePayload(good);
    expect(r).toMatchObject({ ok: true, payload: { legalName: 'Acme Ltd', email: 'sales@acme.co.ke', kraPin: 'P051234567Z', invoicePrefix: 'INV', tagline: null, tel: null, website: null, bankName: null } });
  });

  it('names what is missing', () => {
    expect(errorOf({ legalName: ' ' })).toMatch(/Legal name is required/);
    expect(errorOf({ city: '' })).toMatch(/City is required/);
    expect(errorOf({ country: '' })).toMatch(/Country is required/);
  });

  it('refuses a bad email, phone, PIN, prefix or web address', () => {
    expect(errorOf({ email: 'admin@localhost' })).toMatch(/email/i);
    expect(errorOf({ phone: 'call me' })).toMatch(/mobile/i);
    expect(errorOf({ tel: 'abc' })).toMatch(/landline/i);
    expect(errorOf({ kraPin: '' })).toMatch(/KRA PIN/);
    expect(errorOf({ kraPin: 'X051234567Z' })).toMatch(/KRA PIN/);
    expect(errorOf({ invoicePrefix: 'too long prefix' })).toMatch(/prefix/i);
    expect(errorOf({ website: 'javascript:alert(1)' })).toMatch(/http/);
    expect(errorOf({ website: 'example' })).toMatch(/http/);
  });

  it('keeps a good web address and refuses text that is too long', () => {
    expect(profilePayload({ ...good, website: 'https://acme.example' })).toMatchObject({ ok: true, payload: { website: 'https://acme.example/' } });
    expect(errorOf({ invoiceFooterNote: 'x'.repeat(501) })).toMatch(/up to 500/);
    expect(errorOf({ legalName: 'x'.repeat(121) })).toMatch(/up to 120/);
  });
});

describe('company appearance', () => {
  it('accepts hex colours and a known density, and writes colours the same way each time', () => {
    expect(appearancePayload({ primaryColor: '#ABC', accentColor: '#4F46E5', desktopColumns: 3 })).toEqual({ ok: true, payload: { primaryColor: '#aabbcc', accentColor: '#4f46e5', desktopColumns: 3 } });
  });
  it('refuses anything that is not a colour or a known density', () => {
    expect(appearancePayload({ primaryColor: 'red; background:url(x)', accentColor: '#fff', desktopColumns: 4 }).ok).toBe(false);
    expect(appearancePayload({ primaryColor: '#fff', accentColor: '#fff', desktopColumns: 9 as never }).ok).toBe(false);
  });
});

describe('module names', () => {
  it('keeps only known modules with a name, trimmed', () => {
    expect(moduleLabelsPayload({ sales: '  Selling ', orders: ' ', ghost: 'x' }, ['sales', 'orders'])).toEqual({ ok: true, payload: { sales: 'Selling' } });
  });
  it('refuses a name that is too long', () => {
    expect(moduleLabelsPayload({ sales: 'x'.repeat(81) }, ['sales']).ok).toBe(false);
  });
});
