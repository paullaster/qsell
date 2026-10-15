import { describe, expect, it } from 'vitest';
import { inheritedWords, kraFormFrom, labelOfConnection, labelOfEnvironment, moduleChoiceOf, moduleChoices, withModuleSigning } from './kra-forms';

describe('KRA forms', () => {
  it('starts safe: eTIMS, sandbox, off, no password', () => {
    const f = kraFormFrom(null);
    expect(f).toMatchObject({ mode: 'etims', isEnabled: false, environment: 'sandbox', password: '', allowEtimsSigning: false, allowTimsSigning: false, moduleSigning: {} });
  });
  it('fills from what is saved but never the password', () => {
    const f = kraFormFrom({ mode: 'tims', isEnabled: true, environment: 'production', apiBaseUrl: 'https://x', username: 'u', zfpLabServerUrl: 'http://z', connection: 'com', cuSerial: 'S1', allowEtimsSigning: false, allowTimsSigning: true, moduleSigning: { sales_order: true }, hasPassword: true });
    expect(f).toMatchObject({ mode: 'tims', username: 'u', password: '', connection: 'com', moduleSigning: { sales_order: true } });
  });
  it('words the choices', () => {
    expect(labelOfEnvironment('production')).toBe('Production');
    expect(labelOfConnection('com')).toBe('Serial (COM)');
    expect(labelOfConnection('zzz')).toBe('zzz');
    expect(moduleChoices('on')[0]).toEqual({ id: '', label: 'Use company setting (on)' });
    expect(moduleChoices('off').map((c) => c.id)).toEqual(['', 'on', 'off']);
  });
  it('reads a branch choice and what the company has', () => {
    expect(moduleChoiceOf(undefined)).toBe('');
    expect(moduleChoiceOf(true)).toBe('on');
    expect(moduleChoiceOf(false)).toBe('off');
    expect(inheritedWords(true)).toBe('on');
    expect(inheritedWords(undefined)).toBe('off');
  });
  it('changes one module switch without touching the others, and "follow the company" removes it', () => {
    const start = { ecommerce: true, sales_order: false };
    expect(withModuleSigning(start, 'credit_sale', 'on')).toEqual({ ecommerce: true, sales_order: false, credit_sale: true });
    expect(withModuleSigning(start, 'ecommerce', '')).toEqual({ sales_order: false });
    expect(withModuleSigning(start, 'sales_order', 'on')).toEqual({ ecommerce: true, sales_order: true });
    expect(start).toEqual({ ecommerce: true, sales_order: false });
  });
});
