import { describe, expect, it } from 'vitest';
import { checkDocumentType, emptyDocumentType, parseReminderDays } from './vendor-document-types';

describe('parseReminderDays', () => {
  it('sorts nearest-last and drops repeats', () => expect(parseReminderDays('7, 30,0 7')).toEqual([30, 7, 0]));
  it('accepts none', () => expect(parseReminderDays('')).toEqual([]));
  it('refuses words, negatives and huge numbers', () => {
    expect(parseReminderDays('soon')).toBeNull();
    expect(parseReminderDays('-1')).toBeNull();
    expect(parseReminderDays('400')).toBeNull();
  });
  it('refuses more than six', () => expect(parseReminderDays('1,2,3,4,5,6,7')).toBeNull());
});

describe('checkDocumentType', () => {
  const ok = { ...emptyDocumentType(), code: 'TAX_CLEARANCE', name: 'Tax clearance' };
  it('passes a good form', () => expect(checkDocumentType(ok, true)).toEqual({}));
  it('needs a valid code only when creating', () => {
    expect(checkDocumentType({ ...ok, code: 'bad code' }, true).code).toBeDefined();
    expect(checkDocumentType({ ...ok, code: '' }, false).code).toBeUndefined();
  });
  it('blocking needs an expiry date', () => {
    expect(checkDocumentType({ ...ok, blocking: true }, true).blocking).toBeDefined();
    expect(checkDocumentType({ ...ok, blocking: true, needsExpiry: true }, true).blocking).toBeUndefined();
  });
  it('needs a name', () => expect(checkDocumentType({ ...ok, name: ' ' }, true).name).toBeDefined());
});
