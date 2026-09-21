import type { DimensionRow, DimensionCodesProjection } from '@/server/db/drizzle/schema';

export function globalDimensionFieldName(dimensionNo: number): string {
  return `globalDimension${dimensionNo}Code`;
}

export function shortcutDimensionFieldName(dimensionNo: number): string {
  return `shortcutDimension${dimensionNo}Code`;
}

export type DimensionFieldDescriptor = {
  fieldName: string;
  dimensionId: string;
  dimensionCode: string;
  dimensionNo: number;
  kind: 'global' | 'shortcut';
  optionString: string | null;
};

/** Build the adaptive field contract from company setup. */
export function listDimensionFieldDescriptors(
  dims: DimensionRow[],
): DimensionFieldDescriptor[] {
  const out: DimensionFieldDescriptor[] = [];
  for (const d of dims) {
    if (d.dimensionNo == null) continue;
    if (d.isGlobal) {
      out.push({
        fieldName: globalDimensionFieldName(d.dimensionNo),
        dimensionId: d.id,
        dimensionCode: d.code,
        dimensionNo: d.dimensionNo,
        kind: 'global',
        optionString: d.optionString,
      });
    } else if (d.isShortcut) {
      out.push({
        fieldName: shortcutDimensionFieldName(d.dimensionNo),
        dimensionId: d.id,
        dimensionCode: d.code,
        dimensionNo: d.dimensionNo,
        kind: 'shortcut',
        optionString: d.optionString,
      });
    }
  }
  return out.sort((a, b) => a.dimensionNo - b.dimensionNo);
}

export function emptyDimensionCodes(): DimensionCodesProjection {
  return { global: {}, shortcut: {} };
}

/** Flatten projection into API field map: globalDimension1Code → "NBO". */
export function projectionToFieldMap(
  projection: DimensionCodesProjection,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, code] of Object.entries(projection.global || {})) {
    out[globalDimensionFieldName(Number(n))] = code;
  }
  for (const [n, code] of Object.entries(projection.shortcut || {})) {
    out[shortcutDimensionFieldName(Number(n))] = code;
  }
  return out;
}

/**
 * Parse API/field input into a projection using current setup descriptors.
 * Accepts either flat field names or already-shaped { global, shortcut }.
 */
export function fieldMapToProjection(
  fields: Record<string, string | null | undefined> | DimensionCodesProjection,
  descriptors: DimensionFieldDescriptor[],
): DimensionCodesProjection {
  if (
    fields &&
    typeof fields === 'object' &&
    'global' in fields &&
    'shortcut' in fields &&
    typeof (fields as DimensionCodesProjection).global === 'object' &&
    typeof (fields as DimensionCodesProjection).shortcut === 'object'
  ) {
    const shaped = fields as DimensionCodesProjection;
    return {
      global: { ...(shaped.global || {}) },
      shortcut: { ...(shaped.shortcut || {}) },
    };
  }

  const flat = fields as Record<string, string | null | undefined>;
  const projection = emptyDimensionCodes();
  for (const d of descriptors) {
    const raw = flat[d.fieldName];
    if (raw == null || String(raw).trim() === '') continue;
    const key = String(d.dimensionNo);
    if (d.kind === 'global') projection.global[key] = String(raw).trim().toUpperCase();
    else projection.shortcut[key] = String(raw).trim().toUpperCase();
  }
  return projection;
}

export function buildProjectionFromEntries(
  entries: {
    dimensionNo: number | null;
    isGlobal: boolean;
    isShortcut: boolean;
    dimensionValueCode: string;
  }[],
): DimensionCodesProjection {
  const projection = emptyDimensionCodes();
  for (const e of entries) {
    if (e.dimensionNo == null) continue;
    const key = String(e.dimensionNo);
    if (e.isGlobal) projection.global[key] = e.dimensionValueCode;
    else if (e.isShortcut) projection.shortcut[key] = e.dimensionValueCode;
  }
  return projection;
}
