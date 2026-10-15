/**
 * What the M-Pesa settings and "run an operation" forms turn their typed text into. Pure: the
 * screens only collect text, and the server checks every value again before saving it.
 */
export interface OperationToggle {
  enabled: boolean;
  maxAmount: string;
}

export interface MpesaSettingsForm {
  mode: string;
  windowMinutes: string;
  poll: string;
  cidrs: string;
  responseType: string;
  validation: string;
  autoAllocate: string;
  dailyLimit: string;
  operations: Record<string, OperationToggle>;
}

/** "15, 45, 120" -> [15, 45, 120]; anything that is not a positive number is dropped. */
export function parsePollSeconds(text: string): number[] {
  return text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** One address per line or comma; blanks dropped. */
export function parseAddressList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const blankToNull = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
};

const positiveOr = (text: string, fallback: number): number => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function settingsPatch(form: MpesaSettingsForm): Record<string, unknown> {
  return {
    verification: { mode: form.mode, windowMinutes: positiveOr(form.windowMinutes, 120), pollSeconds: parsePollSeconds(form.poll) },
    security: { allowedCidrs: parseAddressList(form.cidrs) },
    c2b: { responseType: form.responseType, validation: form.validation, autoAllocate: form.autoAllocate },
    dailyPayoutLimit: blankToNull(form.dailyLimit),
    operations: Object.fromEntries(
      Object.entries(form.operations).map(([code, toggle]) => [code, { enabled: toggle.enabled, maxAmount: blankToNull(toggle.maxAmount) }]),
    ),
  };
}

export interface OperationFieldLike {
  key: string;
  defaultValue?: string;
}

/** The operation's input from what was typed or chosen; empty fields are left out. */
export function operationInput(fields: readonly OperationFieldLike[], values: Readonly<Record<string, string>>, operation: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const key = `${operation}.${field.key}`;
    const value = (Object.hasOwn(values, key) ? values[key] : (field.defaultValue ?? '')).trim();
    if (value !== '') input[field.key] = value;
  }
  return input;
}

/** A transaction code is typed in capitals. */
export const fieldText = (key: string, raw: string): string => (key === 'transactionId' ? raw.toUpperCase() : raw);

/** The keyboard a phone should show for a field of this kind. */
export function fieldInputMode(type: string): 'decimal' | 'tel' | undefined {
  if (type === 'number') return 'decimal';
  if (type === 'phone') return 'tel';
  return undefined;
}

/** The hint under a field: its own, or what its pattern expects. */
export function fieldHint(field: { hint?: string; patternHint?: string }): string | undefined {
  if (field.hint !== undefined && field.hint !== '') return field.hint;
  return field.patternHint !== undefined && field.patternHint !== '' ? `Use ${field.patternHint}.` : undefined;
}

/** What the run button says. */
export function runButtonLabel(busy: boolean, moneyOut: boolean): string {
  if (busy) return 'Working…';
  return moneyOut ? 'Request approval' : 'Run';
}
