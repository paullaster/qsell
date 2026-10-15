import { describe, expect, it } from 'vitest';
import { quickDimensionPayload, applyFlagChange, byCode, emptyValueForm, parentValueDimension, valuePayload, dimensionPayload, emptyDimensionForm, formFromDimension, needsDimensionNo, toggledFlags } from './dimension-forms';

const off = { isDefault: false, isGlobal: false, isShortcut: false };

describe('dimension flags', () => {
  it('a default is always global and never a shortcut', () => {
    expect(applyFlagChange({ ...off, isShortcut: true }, { isDefault: true })).toEqual({ isDefault: true, isGlobal: true, isShortcut: false });
  });
  it('global and shortcut exclude each other, the one just ticked winning', () => {
    expect(applyFlagChange({ ...off, isGlobal: true }, { isShortcut: true })).toEqual({ isDefault: false, isGlobal: false, isShortcut: true });
    expect(applyFlagChange({ ...off, isShortcut: true }, { isGlobal: true })).toEqual({ isDefault: false, isGlobal: true, isShortcut: false });
  });
  it('clearing a flag leaves the others alone', () => {
    expect(applyFlagChange({ isDefault: false, isGlobal: true, isShortcut: false }, { isGlobal: false })).toEqual(off);
  });
  it('the list checkboxes follow the same rules', () => {
    expect(toggledFlags(off, 'isDefault', true)).toEqual({ isDefault: true, isGlobal: true, isShortcut: false });
    expect(toggledFlags({ ...off, isGlobal: true }, 'isShortcut', true)).toEqual({ isDefault: false, isGlobal: false, isShortcut: true });
    expect(toggledFlags({ ...off, isShortcut: true }, 'isGlobal', true)).toEqual({ isDefault: false, isGlobal: true, isShortcut: false });
    expect(toggledFlags({ isDefault: true, isGlobal: true, isShortcut: false }, 'isDefault', false)).toEqual({ isDefault: false, isGlobal: true, isShortcut: false });
  });
  it('knows when a number is needed', () => {
    expect(needsDimensionNo(off)).toBe(false);
    expect(needsDimensionNo({ ...off, isShortcut: true })).toBe(true);
  });
});

describe('dimensionPayload', () => {
  const base = { ...emptyDimensionForm(), code: 'WH', name: 'Warehouse' };
  it('needs a code and a name', () => {
    expect(dimensionPayload({ ...base, code: ' ' })).toMatchObject({ ok: false });
    expect(dimensionPayload({ ...base, name: '' })).toMatchObject({ ok: false });
  });
  it('needs a number for global, default and shortcut dimensions', () => {
    expect(dimensionPayload({ ...base, isGlobal: true })).toMatchObject({ ok: false });
    expect(dimensionPayload({ ...base, isGlobal: true, dimensionNo: '2' })).toMatchObject({ ok: true, payload: { dimensionNo: 2, isGlobal: true } });
  });
  it('refuses a number that is not a whole number from 1', () => {
    expect(dimensionPayload({ ...base, dimensionNo: '0' })).toMatchObject({ ok: false });
    expect(dimensionPayload({ ...base, dimensionNo: '1.5' })).toMatchObject({ ok: false });
  });
  it('turns empty optional fields into nothing', () => {
    expect(dimensionPayload(base)).toEqual({ ok: true, payload: { code: 'WH', name: 'Warehouse', description: null, parentId: null, dimensionNo: null, isGlobal: false, isDefault: false, isShortcut: false, optionString: null } });
  });
});

describe('forms and order', () => {
  it('a row becomes a form and back', () => {
    const form = formFromDimension({ code: 'A', name: 'B', description: null, parentId: null, dimensionNo: 3, optionString: 'branch', ...off });
    expect(form).toMatchObject({ dimensionNo: '3', description: '', optionString: 'branch' });
  });
  it('keeps rows in code order', () => {
    expect(byCode([{ code: 'B' }, { code: 'A' }]).map((r) => r.code)).toEqual(['A', 'B']);
  });
});

describe('values', () => {
  it('needs a code and a name', () => {
    expect(valuePayload(emptyValueForm())).toMatchObject({ ok: false });
    expect(valuePayload({ ...emptyValueForm(), code: 'A' })).toMatchObject({ ok: false });
  });
  it('sends empty optional fields as nothing', () => {
    expect(valuePayload({ code: 'A', name: 'B', description: ' ', parentId: '' })).toEqual({ ok: true, payload: { code: 'A', name: 'B', description: null, parentId: null } });
  });
  it('chooses a parent value from the parent dimension when there is one', () => {
    expect(parentValueDimension({ id: 'd', parentId: 'p' })).toBe('p');
    expect(parentValueDimension({ id: 'd', parentId: null })).toBe('d');
  });
});

describe('quickDimensionPayload', () => {
  const ok = { code: 'A', name: 'B', dimensionNo: '2', kind: 'shortcut' as const };
  it('sends the kind as the matching flag', () => {
    expect(quickDimensionPayload(ok)).toEqual({ ok: true, payload: { code: 'A', name: 'B', dimensionNo: 2, isGlobal: false, isShortcut: true } });
    expect(quickDimensionPayload({ ...ok, kind: 'global' })).toMatchObject({ payload: { isGlobal: true, isShortcut: false } });
  });
  it('refuses missing or bad input', () => {
    expect(quickDimensionPayload({ ...ok, code: '' })).toMatchObject({ ok: false });
    expect(quickDimensionPayload({ ...ok, dimensionNo: '0' })).toMatchObject({ ok: false });
    expect(quickDimensionPayload({ ...ok, dimensionNo: '' })).toMatchObject({ ok: false });
  });
});
