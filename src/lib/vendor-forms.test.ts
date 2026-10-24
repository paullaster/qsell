import { describe, expect, it } from 'vitest';
import { checkRegistration, checkVendorCreation, emptyVendorCreation, normaliseTaxId, vendorStatusChoices } from './vendor-forms';

const good = { legalName: 'Acme Supplies Ltd', contactName: 'Wanjiru Kamau', email: 'wanjiru@acme.test', phone: '+254 700 000 000', password: 'long-enough-1' };

describe('vendor registration form', () => {
  it('accepts a complete form', () => {
    expect(checkRegistration(good, null)).toEqual({});
  });

  it('names each field that is wrong', () => {
    const problems = checkRegistration({ legalName: ' ', contactName: 'x', email: 'nope', phone: 'abc', password: '' }, 'Choose a password with at least 8 characters.');
    expect(Object.keys(problems).sort()).toEqual(['contactName', 'email', 'legalName', 'password', 'phone']);
  });

  it('allows the phone to be left out', () => {
    expect(checkRegistration({ ...good, phone: '' }, null)).toEqual({});
  });

  it('refuses a business name longer than 200 characters', () => {
    expect(checkRegistration({ ...good, legalName: 'a'.repeat(201) }, null).legalName).toMatch(/too long/);
  });
});

describe('vendor creation form', () => {
  const ok = { ...emptyVendorCreation(), legalName: 'Acme', email: 'a@acme.test' };

  it('accepts the minimum a person types', () => {
    expect(checkVendorCreation(ok)).toEqual({});
  });

  it('checks terms, currency and kind of business', () => {
    expect(checkVendorCreation({ ...ok, paymentTermDays: '400' }).paymentTermDays).toBeDefined();
    expect(checkVendorCreation({ ...ok, paymentTermDays: '-1' }).paymentTermDays).toBeDefined();
    expect(checkVendorCreation({ ...ok, paymentTermDays: '30.5' }).paymentTermDays).toBeDefined();
    expect(checkVendorCreation({ ...ok, currency: 'KESS' }).currency).toBeDefined();
    expect(checkVendorCreation({ ...ok, currency: 'kes' })).toEqual({});
    expect(checkVendorCreation({ ...ok, vendorType: 'alien' }).vendorType).toBeDefined();
  });
});

describe('tax id', () => {
  it('is compared without case or spaces, and empty means none', () => {
    expect(normaliseTaxId(' p05 1234 x ')).toBe('P051234X');
    expect(normaliseTaxId('   ')).toBeNull();
  });
});

describe('vendor statuses', () => {
  it('lists every status of the lifecycle once', () => {
    const ids = vendorStatusChoices().map((c) => c.id);
    expect(ids).toEqual(['registered', 'profile_in_progress', 'profile_submitted', 'under_review', 'revision_requested', 'active', 'rejected', 'suspended', 'archived']);
  });
});
