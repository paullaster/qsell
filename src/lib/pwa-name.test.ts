import { describe, expect, it } from 'vitest';
import { installedNames, shortNameFrom } from './pwa-name';

describe('the installed app name', () => {
  it('keeps a short name whole', () => {
    expect(shortNameFrom('Kamau Hardware')).toBe('Kamau');
    expect(shortNameFrom('Qsell')).toBe('Qsell');
  });

  it('ends on a whole word, never in the middle of one', () => {
    expect(shortNameFrom('Mwangi & Sons General Merchants Limited')).toBe('Mwangi');
    expect(shortNameFrom('Kamau & Co Stores')).toBe('Kamau & Co');
    expect(shortNameFrom('Tea and Coffee Traders')).toBe('Tea');
    expect(shortNameFrom('Nairobi Fresh Foods')).toBe('Nairobi');
  });

  it('cuts only a first word that is too long by itself', () => {
    expect(shortNameFrom('Supercalifragilistic Traders')).toBe('Supercalifra');
    expect(shortNameFrom('   ')).toBe('');
  });

  it('uses the trading name until the company chooses one', () => {
    expect(installedNames({ tradingName: 'Mwangi & Sons General Merchants' })).toEqual({ name: 'Mwangi & Sons General Merchants', shortName: 'Mwangi' });
  });

  it('uses the chosen name, and makes the short one from it', () => {
    expect(installedNames({ tradingName: 'Mwangi & Sons General Merchants', appName: 'Mwangi Shop' })).toEqual({ name: 'Mwangi Shop', shortName: 'Mwangi Shop' });
  });

  it('uses the chosen short name as it was typed', () => {
    expect(installedNames({ tradingName: 'Mwangi & Sons General Merchants', appName: 'Mwangi Shop Online', appShortName: 'Mwangi' })).toEqual({ name: 'Mwangi Shop Online', shortName: 'Mwangi' });
  });

  it('treats blanks as not chosen', () => {
    expect(installedNames({ tradingName: 'Duka', appName: '  ', appShortName: '' })).toEqual({ name: 'Duka', shortName: 'Duka' });
  });
});
