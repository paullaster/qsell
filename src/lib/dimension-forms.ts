import { has, trimToNull } from '@/lib/values';

/** The three ways a dimension can be offered, which exclude one another in places. */
export interface DimensionFlags {
  isDefault: boolean;
  isGlobal: boolean;
  isShortcut: boolean;
}

export interface DimensionForm extends DimensionFlags {
  code: string;
  name: string;
  description: string;
  parentId: string;
  dimensionNo: string;
  optionString: string;
}

export interface DimensionPayload extends DimensionFlags {
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  dimensionNo: number | null;
  optionString: string | null;
}

export const emptyDimensionForm = (): DimensionForm => ({
  code: '',
  name: '',
  description: '',
  parentId: '',
  dimensionNo: '',
  isGlobal: false,
  isDefault: false,
  isShortcut: false,
  optionString: '',
});

export interface DimensionLike extends DimensionFlags {
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  dimensionNo: number | null;
  optionString: string | null;
}

export function formFromDimension(row: DimensionLike): DimensionForm {
  return {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    parentId: row.parentId ?? '',
    dimensionNo: row.dimensionNo === null ? '' : String(row.dimensionNo),
    isGlobal: row.isGlobal,
    isDefault: row.isDefault,
    isShortcut: row.isShortcut,
    optionString: row.optionString ?? '',
  };
}

/**
 * The flags after one of them is changed. A default is always global and never a shortcut; global and
 * shortcut exclude each other; turning one on wins over what was there.
 */
export function applyFlagChange(current: DimensionFlags, change: Partial<DimensionFlags>): DimensionFlags {
  const isDefault = change.isDefault ?? current.isDefault;
  let isGlobal = change.isGlobal ?? current.isGlobal;
  let isShortcut = change.isShortcut ?? current.isShortcut;
  if (isDefault) {
    isGlobal = true;
    isShortcut = false;
  }
  if (isGlobal && isShortcut) isShortcut = false;
  if (change.isShortcut === true && !isDefault) {
    isShortcut = true;
    isGlobal = false;
  }
  if (change.isGlobal === true && change.isDefault !== true) {
    isGlobal = true;
    isShortcut = false;
  }
  return { isDefault, isGlobal, isShortcut };
}

/** What a row's flags become when one checkbox in the list is ticked or cleared. */
export function toggledFlags(row: DimensionFlags, flag: keyof DimensionFlags, value: boolean): DimensionFlags {
  const next: DimensionFlags = { isGlobal: row.isGlobal, isDefault: row.isDefault, isShortcut: row.isShortcut };
  next[flag] = value;
  if (flag === 'isDefault' && value) {
    next.isGlobal = true;
    next.isShortcut = false;
  }
  if (flag === 'isGlobal' && value) next.isShortcut = false;
  if (flag === 'isShortcut' && value) {
    next.isGlobal = false;
    next.isDefault = false;
  }
  return next;
}

export const needsDimensionNo = (flags: DimensionFlags): boolean => flags.isGlobal || flags.isShortcut || flags.isDefault;

/** The form as it is sent to the server, or what is wrong with it. */
export function dimensionPayload(form: DimensionForm): { ok: true; payload: DimensionPayload } | { ok: false; error: string } {
  if (!has(form.code.trim())) return { ok: false, error: 'Give the dimension a code.' };
  if (!has(form.name.trim())) return { ok: false, error: 'Give the dimension a name.' };
  const no = form.dimensionNo.trim();
  if (needsDimensionNo(form) && no === '') return { ok: false, error: 'A dimension number is needed for default, global and shortcut dimensions.' };
  const parsed = no === '' ? null : Number(no);
  if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1)) return { ok: false, error: 'The dimension number is a whole number from 1.' };
  return {
    ok: true,
    payload: {
      code: form.code,
      name: form.name,
      description: trimToNull(form.description),
      parentId: has(form.parentId) ? form.parentId : null,
      dimensionNo: parsed,
      isGlobal: form.isGlobal,
      isDefault: form.isDefault,
      isShortcut: form.isShortcut,
      optionString: has(form.optionString) ? form.optionString : null,
    },
  };
}

/** Rows kept in code order after one is added or changed. */
export function byCode<T extends { code: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.code.localeCompare(b.code));
}

export interface DimensionValueForm {
  code: string;
  name: string;
  description: string;
  parentId: string;
}

export const emptyValueForm = (): DimensionValueForm => ({ code: '', name: '', description: '', parentId: '' });

/** A value's form as it is sent to the server, or what is wrong with it. */
export function valuePayload(form: DimensionValueForm): { ok: true; payload: { code: string; name: string; description: string | null; parentId: string | null } } | { ok: false; error: string } {
  if (!has(form.code.trim())) return { ok: false, error: 'Give the value a code.' };
  if (!has(form.name.trim())) return { ok: false, error: 'Give the value a name.' };
  return { ok: true, payload: { code: form.code, name: form.name, description: trimToNull(form.description), parentId: has(form.parentId) ? form.parentId : null } };
}

/** Which dimension a value's parent is chosen from: the dimension's own parent dimension, else the same one. */
export const parentValueDimension = (dimension: { id: string; parentId: string | null }): string => dimension.parentId ?? dimension.id;

export const DIMENSION_KINDS = [
  { id: 'global', label: 'Global dimension' },
  { id: 'shortcut', label: 'Shortcut dimension' },
] as const;

export type DimensionKind = (typeof DIMENSION_KINDS)[number]['id'];

/** The quick "create a dimension" form (code, name, number, and how customers use it) as it is sent. */
export function quickDimensionPayload(form: { code: string; name: string; dimensionNo: string; kind: DimensionKind }):
  | { ok: true; payload: { code: string; name: string; dimensionNo: number; isGlobal: boolean; isShortcut: boolean } }
  | { ok: false; error: string } {
  if (!has(form.code.trim())) return { ok: false, error: 'Give the dimension a code.' };
  if (!has(form.name.trim())) return { ok: false, error: 'Give the dimension a name.' };
  const no = Number(form.dimensionNo);
  if (form.dimensionNo.trim() === '' || !Number.isInteger(no) || no < 1) return { ok: false, error: 'The dimension number is a whole number from 1.' };
  return { ok: true, payload: { code: form.code, name: form.name, dimensionNo: no, isGlobal: form.kind === 'global', isShortcut: form.kind === 'shortcut' } };
}
