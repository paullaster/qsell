import { describe, expect, it } from 'vitest';
import {
  allStatuses, checkBanks, checkBusiness, checkContacts, checkDirectors, checkProfile, emptyBusiness, emptyFinancial, emptyProfile,
  mayEditProfile, mayEditSection, missingIn, profileComplete, sectionStatus, type ProfileState,
} from './vendor-profile';

const goodProfile = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
const goodBusiness = { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: 'P051234567X' };
const contact = { name: 'Wanjiru Kamau', role: 'management', email: 'w@acme.test', phone: '0700000000', isPrimary: true };

const state = (over: Partial<ProfileState> = {}): ProfileState => ({
  profile: goodProfile,
  business: goodBusiness,
  financial: { ...emptyFinancial(), offeredPaymentTermDays: '30' },
  contacts: [contact],
  directors: [{ name: 'Wanjiru Kamau', idType: 'national_id', sharePercent: '100' }],
  references: [],
  banks: 1,
  requiredDocuments: [{ code: 'TAX', name: 'tax compliance certificate', held: true, needsExpiry: true, hasExpiry: true }],
  taxPattern: null,
  ...over,
});

describe('profile section rules', () => {
  it('a complete profile has no problems; an empty one lists what is needed', () => {
    expect(checkProfile(goodProfile)).toEqual({});
    expect(Object.keys(checkProfile(emptyProfile())).sort()).toEqual(['country', 'description', 'phone', 'physicalCity', 'physicalStreet']);
  });

  it('checks the year, website and description length', () => {
    expect(checkProfile({ ...goodProfile, yearEstablished: '12' }).yearEstablished).toBeDefined();
    expect(checkProfile({ ...goodProfile, yearEstablished: '3000' }).yearEstablished).toBeDefined();
    expect(checkProfile({ ...goodProfile, website: 'acme.test' }).website).toBeDefined();
    expect(checkProfile({ ...goodProfile, website: 'https://acme.test' })).toEqual({});
    expect(checkProfile({ ...goodProfile, description: 'x'.repeat(2001) }).description).toMatch(/too long/);
  });

  it('refuses a registration date in the future or not a date, and holds the tax id to the pack pattern', () => {
    expect(checkBusiness({ ...goodBusiness, registrationDate: '2999-01-01' }).registrationDate).toBeDefined();
    expect(checkBusiness({ ...goodBusiness, registrationDate: '2012-02-31' }).registrationDate).toBeDefined();
    expect(checkBusiness(goodBusiness, /^[A-Z]\d{9}[A-Z]$/)).toEqual({});
    expect(checkBusiness({ ...goodBusiness, taxId: 'P05123' }, /^[A-Z]\d{9}[A-Z]$/).taxId).toBeDefined();
  });

  it('wants exactly one main contact and a valid email and phone for each', () => {
    expect(checkContacts([contact])).toEqual({});
    expect(checkContacts([])).toHaveProperty('contacts');
    expect(checkContacts([contact, { ...contact, name: 'Other' }]).contacts).toMatch(/exactly one/);
    expect(checkContacts([{ ...contact, isPrimary: false }]).contacts).toMatch(/exactly one/);
    expect(Object.keys(checkContacts([{ ...contact, email: 'x', phone: 'y', role: 'boss' }])).sort()).toEqual(['contacts.0.email', 'contacts.0.phone', 'contacts.0.role']);
  });

  it('wants a director, and shares that do not exceed 100%', () => {
    const d = { name: 'A B', idType: 'national_id', idNumber: '12345678', sharePercent: '60' };
    expect(checkDirectors([d])).toEqual({});
    expect(checkDirectors([])).toHaveProperty('directors');
    expect(checkDirectors([d, { ...d, name: 'C D', sharePercent: '60' }]).directors).toMatch(/more than 100/);
  });

  it('checks bank account details', () => {
    const b = { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: '1234567890', swift: '' };
    expect(checkBanks([b])).toEqual({});
    expect(Object.keys(checkBanks([{ ...b, accountNumber: '12', swift: 'ABC' }])).sort()).toEqual(['banks.0.accountNumber', 'banks.0.swift']);
  });
});

describe('completeness', () => {
  it('a vendor with everything is complete', () => {
    expect(profileComplete(state())).toBe(true);
  });

  it('a section with nothing in it is "not started", a half-filled one is "draft"', () => {
    const empty = state({ profile: emptyProfile(), business: emptyBusiness(), financial: emptyFinancial(), contacts: [], directors: [], banks: 0, requiredDocuments: [{ code: 'TAX', name: 'tax compliance certificate', held: false, needsExpiry: true, hasExpiry: false }] });
    expect(Object.values(allStatuses(empty))).toEqual(['not_started', 'not_started', 'not_started', 'not_started', 'not_started']);
    expect(sectionStatus('profile', { ...empty, profile: { ...emptyProfile(), description: 'only this' } })).toBe('draft');
  });

  it('the financial section needs a bank account; the attachments need each required document with its expiry date', () => {
    expect(missingIn('financial', state({ banks: 0 }))).toContain('Add at least one bank account.');
    const noExpiry = state({ requiredDocuments: [{ code: 'TAX', name: 'tax compliance certificate', held: true, needsExpiry: true, hasExpiry: false }] });
    expect(missingIn('attachments', noExpiry)).toEqual(['Enter the expiry date of your tax compliance certificate.']);
    expect(missingIn('attachments', state({ requiredDocuments: [{ code: 'TAX', name: 'tax compliance certificate', held: false, needsExpiry: true, hasExpiry: false }] }))).toEqual(['Upload your tax compliance certificate.']);
  });
});

describe('who may change what', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  it('a vendor may change its profile until it submits, and again when asked to revise', () => {
    for (const s of ['registered', 'profile_in_progress', 'revision_requested']) expect(mayEditProfile(s, null, now)).toBe(true);
    for (const s of ['profile_submitted', 'under_review', 'active', 'suspended', 'archived']) expect(mayEditProfile(s, null, now)).toBe(false);
  });

  it('a refused vendor may apply again only after the waiting period', () => {
    expect(mayEditProfile('rejected', new Date('2026-10-01T00:00:00Z'), now)).toBe(false);
    expect(mayEditProfile('rejected', new Date('2026-09-01T00:00:00Z'), now)).toBe(true);
  });

  it('portal roles are limited to their sections', () => {
    expect(mayEditSection('owner', 'business')).toBe(true);
    expect(mayEditSection('finance', 'financial')).toBe(true);
    expect(mayEditSection('finance', 'business')).toBe(false);
    expect(mayEditSection('sales', 'contacts')).toBe(true);
    expect(mayEditSection('sales', 'financial')).toBe(false);
    expect(mayEditSection('readonly', 'attachments')).toBe(false);
  });
});
