import { plainText } from '@/lib/reports/messages';
import { FAMILY_CODES, FAMILY_LABELS, REPORTS } from '.';

/** The report modules that have at least one report to open (the Business Overview is a home screen, not a report). */
export function reportModules(): { code: string; label: string }[] {
  return FAMILY_CODES.filter((family) =>
    REPORTS.some((r) => r.family === family && r.view !== 'overview'),
  ).map((family) => ({ code: family, label: plainText(FAMILY_LABELS[family]) }));
}

export const reportModuleCodes = (): string[] => reportModules().map((m) => m.code);
