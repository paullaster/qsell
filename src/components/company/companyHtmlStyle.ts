import type { CSSProperties } from 'react';
import { companyThemeStyleAttribute } from '@/config/company-ui';

/** Build a style object of company CSS variables for `<html style={...}>`. */
export function companyHtmlStyle(
  primaryColor: string | null | undefined,
  accentColor: string | null | undefined,
): CSSProperties {
  const raw = companyThemeStyleAttribute({
    primaryColor: primaryColor ?? undefined,
    accentColor: accentColor ?? undefined,
  });
  const style: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && value) style[key] = value;
  }
  return style as CSSProperties;
}
