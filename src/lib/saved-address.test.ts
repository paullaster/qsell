import { describe, expect, it } from 'vitest';
import { holdsPlace, pinOfAddress, sameAddress, saveDecision } from './saved-address';

const home = { id: 'a1', street: '12 Moi Avenue', city: 'Nairobi', latitude: -1.2921, longitude: 36.8219 };
const written = { id: 'a2', street: '5 Kimathi Street', city: 'Nairobi', latitude: null, longitude: null };

describe('a saved address and its place on the map', () => {
  it('gives the place only when both numbers are there', () => {
    expect(pinOfAddress(home)).toEqual({ latitude: -1.2921, longitude: 36.8219 });
    expect(pinOfAddress(written)).toBeNull();
    expect(pinOfAddress({ latitude: -1.2 })).toBeNull();
    expect(pinOfAddress({ latitude: undefined, longitude: undefined })).toBeNull();
  });
  it('reads the same address however it is spaced or cased', () => {
    expect(sameAddress({ street: ' 12  moi AVENUE', city: 'nairobi ' }, home)).toBe(true);
    expect(sameAddress({ street: '13 Moi Avenue', city: 'Nairobi' }, home)).toBe(false);
  });
  it('holds a place to the six places that are kept', () => {
    expect(holdsPlace(home, { latitude: -1.2921, longitude: 36.8219 })).toBe(true);
    expect(holdsPlace(home, { latitude: -1.2921004, longitude: 36.8219003 })).toBe(true);
    expect(holdsPlace(home, { latitude: -1.2922, longitude: 36.8219 })).toBe(false);
    expect(holdsPlace(written, { latitude: -1.2921, longitude: 36.8219 })).toBe(false);
  });
  it('saves what was delivered to once: a new address is added, the same one with its place is left, the same one without its place is given it', () => {
    const here = { latitude: -1.3001, longitude: 36.7802 };
    expect(saveDecision([home, written], { street: 'Ngong Road', city: 'Nairobi' }, here)).toEqual({ kind: 'add' });
    expect(saveDecision([home, written], { street: '12 Moi Avenue', city: 'Nairobi' }, { latitude: -1.2921, longitude: 36.8219 })).toEqual({ kind: 'none' });
    expect(saveDecision([home, written], { street: '5 Kimathi Street', city: 'Nairobi' }, here)).toEqual({ kind: 'attach', id: 'a2' });
    // Only written, and already in the book: nothing to add. Only written and new: added.
    expect(saveDecision([home, written], { street: '5 kimathi street', city: 'nairobi' }, null)).toEqual({ kind: 'none' });
    expect(saveDecision([home], { street: 'Ngong Road', city: 'Nairobi' }, null)).toEqual({ kind: 'add' });
    expect(saveDecision([], { street: 'Ngong Road', city: 'Nairobi' }, here)).toEqual({ kind: 'add' });
  });
});
