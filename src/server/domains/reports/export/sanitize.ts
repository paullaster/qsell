import { guardFormula } from '@/lib/csv';

/**
 * Text that comes from people or from data (a customer's name, a product description) must never run as a formula
 * when a file is opened in a spreadsheet. One function for every export format: control characters that can corrupt a
 * file are removed, and text that starts like a formula gets the usual apostrophe prefix (`lib/csv.ts` owns the rule and
 * the refund files use it too). Numbers are written as numbers and need no guard.
 */

// Everything below space except tab, line feed and carriage return, and the delete character.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Remove characters no file format should carry. */
export function stripControls(value: string): string {
  return value.replace(CONTROL, '');
}

/** Text that is safe to put in any cell of any export. */
export function safeText(value: string): string {
  return guardFormula(stripControls(value));
}
