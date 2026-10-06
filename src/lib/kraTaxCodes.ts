/**
 * KRA tax classification codes. TIMS (control unit) and eTIMS (VSCU) use the same
 * letters for different rates, so each tax category stores one code per scheme.
 */
export interface KraTaxCodeOption {
  code: string;
  label: string;
}

export const TIMS_TAX_CODES: KraTaxCodeOption[] = [
  { code: 'A', label: 'A — 16%' },
  { code: 'B', label: 'B — 8%' },
  { code: 'C', label: 'C — 0%' },
  { code: 'D', label: 'D — Other' },
  { code: 'E', label: 'E — Exempt' },
];

export const ETIMS_TAX_CODES: KraTaxCodeOption[] = [
  { code: 'A', label: 'A — Exempt' },
  { code: 'B', label: 'B — 16%' },
  { code: 'C', label: 'C — 0%' },
  { code: 'D', label: 'D — Non-VAT' },
  { code: 'E', label: 'E — 8%' },
];

/** Empty string means "not mapped to this scheme". */
export function isValidTimsCode(code: string): boolean {
  return code === '' || TIMS_TAX_CODES.some((o) => o.code === code);
}

export function isValidEtimsCode(code: string): boolean {
  return code === '' || ETIMS_TAX_CODES.some((o) => o.code === code);
}
