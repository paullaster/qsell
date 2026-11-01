import { describe, expect, it } from 'vitest';
import { areaSpecificity, areaWords, countyKey, matchArea, placeKey, readAreaInput, readAreaLines, readZoneInput, resolveZone, zoneForPin, type ZoneAreaRow, type ZoneCircle } from './delivery-zones';

const area = (id: string, zoneId: string, county = '', town = '', place = ''): ZoneAreaRow => ({ id, zoneId, countyKey: countyKey(county), townKey: placeKey(town), areaKey: placeKey(place) });

describe('place names as keys', () => {
  it('ignore case, accents, punctuation and spacing', () => {
    expect(placeKey('  Westlands, ')).toBe('westlands');
    expect(placeKey('WESTLANDS')).toBe('westlands');
    expect(placeKey("Murang'a")).toBe('murang a');
    expect(placeKey('Kilimani   Estate')).toBe('kilimani estate');
    expect(placeKey('Nyali – Mombasa')).toBe('nyali mombasa');
    expect(placeKey('Café Řeka')).toBe('cafe reka');
    expect(placeKey(null)).toBe('');
    expect(placeKey('   ')).toBe('');
  });
  it('drop the word county around a county', () => {
    expect(countyKey('Nairobi County')).toBe('nairobi');
    expect(countyKey('County of Kisumu')).toBe('kisumu');
    expect(countyKey('NAIROBI')).toBe('nairobi');
    expect(countyKey('Kiambu')).toBe('kiambu');
  });
});

describe('matching a written address to an area', () => {
  const rows = [
    area('a1', 'Z-NAIROBI', 'Nairobi'),
    area('a2', 'Z-WEST', 'Nairobi', 'Westlands'),
    area('a3', 'Z-KILI', 'Nairobi', '', 'Kilimani'),
    area('a4', 'Z-PARK', '', '', 'Parklands'),
    area('a5', 'Z-MSA', 'Mombasa'),
  ];
  it('uses the most specific area that covers the address', () => {
    expect(matchArea(rows, { county: 'Nairobi', town: 'Westlands', area: 'Sarit' })?.id).toBe('a2');
    expect(matchArea(rows, { county: 'Nairobi County', town: 'Nairobi', area: 'Kilimani' })?.id).toBe('a3');
    expect(matchArea(rows, { county: 'Nairobi', town: 'CBD' })?.id).toBe('a1');
    expect(matchArea(rows, { area: 'parklands' })?.id).toBe('a4');
    expect(matchArea(rows, { county: 'Mombasa', town: 'Nyali' })?.id).toBe('a5');
  });
  it('lets an area beat a town beat a county, whatever the order the rows come in', () => {
    const both = [area('t', 'Z1', 'Nairobi', 'Westlands'), area('a', 'Z2', 'Nairobi', '', 'Kilimani')];
    for (const order of [both, [...both].reverse()]) expect(matchArea(order, { county: 'Nairobi', town: 'Westlands', area: 'Kilimani' })?.id).toBe('a');
    expect(areaSpecificity(area('x', 'z', 'n'))).toBeLessThan(areaSpecificity(area('x', 'z', '', 'w')));
    expect(areaSpecificity(area('x', 'z', 'n', 'w'))).toBeLessThan(areaSpecificity(area('x', 'z', '', '', 'k')));
  });
  it('finds nothing for an address nobody covers, or one with no words, and never matches an empty row to everything', () => {
    expect(matchArea(rows, { county: 'Kisumu', town: 'Milimani' })).toBeNull();
    expect(matchArea(rows, {})).toBeNull();
    expect(matchArea(rows, { county: '  ', town: '' })).toBeNull();
    expect(matchArea([area('blank', 'z')], { county: 'Nairobi' })).toBeNull();
  });
  it('no two different sets of words score the same, so one area per set of words means one answer', () => {
    const scores = new Set<number>();
    for (const c of [false, true]) for (const t of [false, true]) for (const a of [false, true]) scores.add(areaSpecificity({ countyKey: c ? 'c' : '', townKey: t ? 't' : '', areaKey: a ? 'a' : '' }));
    expect(scores.size).toBe(8);
  });
});

describe('finding a zone from a pin', () => {
  const circle = (id: string, code: string, lat: number | null, lng: number | null, radiusKm: number | null): ZoneCircle => ({ id, code, centre: lat === null || lng === null ? null : { latitude: lat, longitude: lng }, radiusKm });
  const cbd = circle('1', 'CBD', -1.2864, 36.8172, 3);
  const metro = circle('2', 'METRO', -1.2864, 36.8172, 25);
  const none = circle('3', 'NOCIRCLE', null, null, null);
  it('holds a pin inside the circle and not one outside', () => {
    expect(zoneForPin([cbd], { latitude: -1.29, longitude: 36.82 })?.zone.code).toBe('CBD');
    expect(zoneForPin([cbd], { latitude: -1.45, longitude: 36.82 })).toBeNull();
    expect(zoneForPin([none], { latitude: -1.29, longitude: 36.82 })).toBeNull();
  });
  it('picks the nearest centre, then the smaller circle, then the code, so a pin has one answer', () => {
    expect(zoneForPin([metro, cbd], { latitude: -1.2864, longitude: 36.8172 })?.zone.code).toBe('CBD');
    const a = circle('a', 'A', 0, 0, 10);
    const b = circle('b', 'B', 0, 0, 10);
    expect(zoneForPin([b, a], { latitude: 0.01, longitude: 0 })?.zone.code).toBe('A');
    expect(zoneForPin([a, b], { latitude: 0.01, longitude: 0 })?.zone.code).toBe('A');
    const near = circle('n', 'NEAR', 0, 0.05, 50);
    const far = circle('f', 'FAR', 0, 0.2, 5);
    expect(zoneForPin([far, near], { latitude: 0, longitude: 0.06 })?.zone.code).toBe('NEAR');
  });
});

describe('where a delivery goes', () => {
  const west: ZoneCircle & { name: string } = { id: 'W', code: 'WEST', name: 'West', centre: { latitude: -1.26, longitude: 36.8 }, radiusKm: 6 };
  const south: ZoneCircle & { name: string } = { id: 'S', code: 'SOUTH', name: 'South', centre: null, radiusKm: null };
  const areas = [{ ...area('a1', 'S', 'Nairobi', 'Karen'), zone: south }];
  it('lets a pin in a circle decide, and falls back to the written address', () => {
    const inCircle = resolveZone({ zones: [west, south], areas, address: { county: 'Nairobi', town: 'Karen' }, pin: { latitude: -1.26, longitude: 36.8 } });
    expect(inCircle).toMatchObject({ by: 'pin', zone: { code: 'WEST' } });
    const outside = resolveZone({ zones: [west, south], areas, address: { county: 'Nairobi', town: 'Karen' }, pin: { latitude: -1.5, longitude: 36.5 } });
    expect(outside).toMatchObject({ by: 'address', zone: { code: 'SOUTH' }, areaId: 'a1' });
    expect(resolveZone({ zones: [west, south], areas, address: { county: 'Nairobi', town: 'Karen' } })).toMatchObject({ by: 'address' });
  });
  it('says nothing when neither the pin nor the words are covered', () => {
    expect(resolveZone({ zones: [west], areas, address: { county: 'Kisumu' }, pin: { latitude: 5, longitude: 5 } })).toBeNull();
    expect(resolveZone({ zones: [west], areas })).toBeNull();
    expect(resolveZone({ zones: [west], areas, pin: null })).toBeNull();
  });
});

describe('reading a zone', () => {
  const ok = { code: ' west ', name: ' Westlands ', description: '', centreLatitude: '', centreLongitude: '', radiusKm: '' };
  it('keeps the code in capitals and has no circle unless all three parts are given', () => {
    expect(readZoneInput(ok)).toEqual({ ok: true, value: { code: 'WEST', name: 'Westlands', description: null, centre: null, radiusKm: null } });
    const full = readZoneInput({ ...ok, centreLatitude: '-1.2640', centreLongitude: ' 36.8070', radiusKm: '4.5' });
    expect(full).toEqual({ ok: true, value: { code: 'WEST', name: 'Westlands', description: null, centre: { latitude: -1.264, longitude: 36.807 }, radiusKm: 4.5 } });
  });
  it('refuses, in plain words, what cannot be a zone', () => {
    const err = (over: Record<string, unknown>) => {
      const r = readZoneInput({ ...ok, ...over });
      return r.ok ? 'OK' : r.error;
    };
    expect(err({ code: '' })).toBe('Give the zone a code.');
    expect(err({ code: 'bad code!' })).toMatch(/up to 20 letters/);
    expect(err({ name: '  ' })).toBe('Give the zone a name.');
    expect(err({ name: 'x'.repeat(81) })).toMatch(/at most 80/);
    expect(err({ centreLatitude: '1' })).toMatch(/needs a latitude, a longitude and a radius/);
    expect(err({ centreLatitude: '95', centreLongitude: '1', radiusKm: '2' })).toMatch(/real place/);
    expect(err({ centreLatitude: 'x', centreLongitude: '1', radiusKm: '2' })).toMatch(/real place/);
    expect(err({ centreLatitude: '1', centreLongitude: '1', radiusKm: '0' })).toMatch(/more than 0/);
    expect(err({ centreLatitude: '1', centreLongitude: '1', radiusKm: '2001' })).toMatch(/at most 2000/);
  });
});

describe('reading areas', () => {
  it('needs at least one part, and shows them from the narrowest to the widest', () => {
    expect(readAreaInput({ county: '', town: ' ', area: '' })).toEqual({ ok: false, error: 'Give at least a county, a town or an area.' });
    const r = readAreaInput({ county: 'Nairobi County', town: 'Westlands', area: 'Sarit' });
    expect(r).toMatchObject({ ok: true, value: { countyKey: 'nairobi', townKey: 'westlands', areaKey: 'sarit' } });
    expect(areaWords({ county: 'Nairobi', town: 'Westlands', area: null })).toBe('Westlands, Nairobi');
    expect(areaWords({ county: null, town: null, area: 'Kilimani' })).toBe('Kilimani');
  });
  it('reads pasted lines, keeping a place for a missing part, and says what is wrong with a line', () => {
    const r = readAreaLines('Nairobi, Westlands, Sarit\n, Kilimani\nMombasa\n\n,,\nNairobi,westlands,SARIT\n');
    expect(r.areas.map((a) => [a.countyKey, a.townKey, a.areaKey])).toEqual([['nairobi', 'westlands', 'sarit'], ['', 'kilimani', ''], ['mombasa', '', '']]);
    expect(r.problems).toEqual([
      { line: 5, text: ',,', error: 'Give at least a county, a town or an area.' },
      { line: 6, text: 'Nairobi,westlands,SARIT', error: 'The same area is on an earlier line.' },
    ]);
    expect(r.tooMany).toBe(false);
  });
  it('stops at the limit and says so', () => {
    const many = Array.from({ length: 250 }, (_, i) => `Nairobi, Town ${String(i)}`).join('\n');
    const r = readAreaLines(many, 200);
    expect(r.areas).toHaveLength(200);
    expect(r.tooMany).toBe(true);
  });
});
