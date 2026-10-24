/** The shape and rules of a document type a company asks vendors for. Pure, shared by the form and the server. */

export interface DocumentTypeForm {
  code: string;
  name: string;
  requiredForAll: boolean;
  needsExpiry: boolean;
  /** Days before expiry, comma separated, for example `30, 7, 0`. */
  reminderDays: string;
  blocking: boolean;
  isActive: boolean;
}

export const emptyDocumentType = (): DocumentTypeForm => ({ code: '', name: '', requiredForAll: false, needsExpiry: false, reminderDays: '30, 7, 0', blocking: false, isActive: true });

export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;

/** `"30, 7,0"` becomes `[30, 7, 0]`; null when something is not a whole number of days from 0 to 365, or there are too many. */
export function parseReminderDays(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter((p) => p !== '');
  if (parts.length > 6) return null;
  const days: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 365) return null;
    if (!days.includes(n)) days.push(n);
  }
  return days.sort((a, b) => b - a);
}

/** Field problems keyed by field name; empty when the form is fine. `creating` allows the code to be set. */
export function checkDocumentType(f: DocumentTypeForm, creating: boolean): Record<string, string> {
  const problems: Record<string, string> = {};
  if (creating && !CODE_PATTERN.test(f.code.trim().toUpperCase())) problems.code = 'Use capital letters, digits, dots, dashes or underscores, up to 30 characters (for example TAX_CLEARANCE).';
  const name = f.name.trim();
  if (name.length < 2 || name.length > 80) problems.name = 'Give the document a name of 2 to 80 characters.';
  if (parseReminderDays(f.reminderDays) === null) problems.reminderDays = 'List up to six whole numbers of days from 0 to 365, like 30, 7, 0.';
  if (f.blocking && !f.needsExpiry) problems.blocking = 'Only a document with an expiry date can block anything when it expires.';
  return problems;
}
