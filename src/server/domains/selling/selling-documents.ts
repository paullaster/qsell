/**
 * The selling documents staff can raise, and the behaviour of each. The registry (types, the options each setting allows, the defaults)
 * lives here; a company's own choices are stored and read through `readSellingSettings`, which can never fail: what is missing or
 * invalid falls back to the default. Pure; see docs/architecture/selling-documents.md section 4.6.
 */
export const SELLING_TYPES = ['sales_order', 'sales_invoice', 'credit_sale', 'pos_cash_sale'] as const;
export type SellingType = (typeof SELLING_TYPES)[number];
export const isSellingType = (value: unknown): value is SellingType => typeof value === 'string' && (SELLING_TYPES as readonly string[]).includes(value);

export const CREDIT_CHECKS = ['off', 'limit', 'limit_and_overdue'] as const;
export const NO_ACCOUNT_RULES = ['allow', 'refuse', 'pay_first'] as const;
export const OVER_LIMIT_RULES = ['refuse', 'hold'] as const;
export const CREDIT_DAYS_RULES = ['customer', 'fixed', 'on_issue'] as const;
export const STOCK_RELEASES = ['on_issue', 'on_payment', 'on_delivery'] as const;
export const APPROVAL_RULES = ['workflow', 'always', 'never'] as const;
export const INVOICE_TIMINGS = ['with_document', 'later'] as const;
export const DISCOUNT_RULES = ['allowed', 'not_allowed'] as const;

export interface SellingSettings {
  creditCheck: (typeof CREDIT_CHECKS)[number];
  /** For `limit_and_overdue`: an invoice overdue by more than this many days counts (0 to 365). */
  overdueDays: number;
  noAccount: (typeof NO_ACCOUNT_RULES)[number];
  overLimit: (typeof OVER_LIMIT_RULES)[number];
  creditDays: (typeof CREDIT_DAYS_RULES)[number];
  /** For `fixed`: the number of days (0 to 365). */
  fixedDays: number;
  stockRelease: (typeof STOCK_RELEASES)[number];
  approval: (typeof APPROVAL_RULES)[number];
  invoice: (typeof INVOICE_TIMINGS)[number];
  discounts: (typeof DISCOUNT_RULES)[number];
  /** Staff may switch "Hold until paid" on for one document, whatever the type's stock release says. */
  allowHoldUntilPaid: boolean;
}

export type SettingName = keyof SellingSettings;

/** The choices each enumerated setting allows. */
export const OPTIONS = {
  creditCheck: CREDIT_CHECKS,
  noAccount: NO_ACCOUNT_RULES,
  overLimit: OVER_LIMIT_RULES,
  creditDays: CREDIT_DAYS_RULES,
  stockRelease: STOCK_RELEASES,
  approval: APPROVAL_RULES,
  invoice: INVOICE_TIMINGS,
  discounts: DISCOUNT_RULES,
} as const;
export type EnumSetting = keyof typeof OPTIONS;
export const ENUM_SETTINGS = Object.keys(OPTIONS) as EnumSetting[];

/** The words of each choice, for the screen. */
export const OPTION_WORDS: Record<EnumSetting, Record<string, { label: string; description: string }>> = {
  creditCheck: {
    off: { label: 'No credit check', description: 'The customer\'s limit is not looked at' },
    limit: { label: 'Check the credit limit', description: 'Their balance plus this document must be within the limit' },
    limit_and_overdue: { label: 'Check the limit and overdue invoices', description: 'Also refuse or hold when an invoice is overdue by more than the days below' },
  },
  noAccount: {
    allow: { label: 'Allow', description: 'A customer without a credit account may buy' },
    refuse: { label: 'Refuse', description: 'Only customers with a credit account' },
    pay_first: { label: 'Require payment first', description: 'A customer without a credit account must pay before the goods are released' },
  },
  overLimit: {
    refuse: { label: 'Refuse', description: 'The document is not accepted' },
    hold: { label: 'Hold and ask for approval', description: 'The document is kept on hold with its stock reserved until approved or rejected' },
  },
  creditDays: {
    customer: { label: 'The customer\'s payment terms', description: 'Due after the days on the customer\'s account' },
    fixed: { label: 'A fixed number of days', description: 'The same days for every customer' },
    on_issue: { label: 'Due on issue', description: 'No credit days: due when issued' },
  },
  stockRelease: {
    on_issue: { label: 'When the document is issued', description: 'Stock leaves (is issued) as soon as the document is issued' },
    on_payment: { label: 'When payment is received', description: 'Hold until paid: stock is reserved and leaves when payment is confirmed' },
    on_delivery: { label: 'At delivery or collection', description: 'Stock leaves at goods issue, when the goods are handed over' },
  },
  approval: {
    workflow: { label: 'By the company\'s approval workflows', description: 'Waits only when a workflow matches' },
    always: { label: 'Always needs approval', description: 'Every document waits for an approver' },
    never: { label: 'Never needs approval', description: 'No document waits (price floors and limits still apply)' },
  },
  invoice: {
    with_document: { label: 'Issued with the document', description: 'The tax invoice is made when the document is placed' },
    later: { label: 'Raised by staff later', description: 'Staff raise the invoice, usually at delivery or collection' },
  },
  discounts: {
    allowed: { label: 'Staff may discount', description: 'The pricing guard and override limits still apply' },
    not_allowed: { label: 'No discounts', description: 'Prices are as listed' },
  },
};

export interface SellingTypeDef {
  type: SellingType;
  label: string;
  description: string;
  defaults: SellingSettings;
  /** The choices this type does not offer (a cash sale has no credit). */
  limits: Partial<Record<EnumSetting, readonly string[]>>;
}

const base: SellingSettings = { creditCheck: 'limit', overdueDays: 30, noAccount: 'allow', overLimit: 'hold', creditDays: 'customer', fixedDays: 30, stockRelease: 'on_delivery', approval: 'workflow', invoice: 'later', discounts: 'allowed', allowHoldUntilPaid: true };

export const SELLING_TYPE_DEFS: readonly SellingTypeDef[] = [
  { type: 'sales_order', label: 'Sales orders', description: 'An order staff take for later collection or delivery.', defaults: base, limits: {} },
  { type: 'credit_sale', label: 'Credit sales', description: 'A sale to a customer\'s account, invoiced at once.', defaults: { ...base, noAccount: 'refuse', invoice: 'with_document' }, limits: { noAccount: ['refuse'] } },
  { type: 'sales_invoice', label: 'Sales invoices', description: 'A sale invoiced directly, with no sales order.', defaults: { ...base, stockRelease: 'on_issue', invoice: 'with_document' }, limits: { invoice: ['with_document'] } },
  { type: 'pos_cash_sale', label: 'Cash sales', description: 'A counter sale paid at once, inside a shift.', defaults: { ...base, creditCheck: 'off', noAccount: 'allow', overLimit: 'refuse', creditDays: 'on_issue', stockRelease: 'on_issue', approval: 'never', invoice: 'with_document', allowHoldUntilPaid: false }, limits: { creditCheck: ['off'], noAccount: ['allow'], overLimit: ['refuse'], creditDays: ['on_issue'], stockRelease: ['on_issue'], approval: ['never'], invoice: ['with_document'] } },
];

export function defOf(type: SellingType): SellingTypeDef {
  const found = SELLING_TYPE_DEFS.find((d) => d.type === type);
  if (found === undefined) throw new Error(`No such selling document type: ${type}`);
  return found;
}

/** The choices of a setting that a type offers. */
export function allowedOptions(type: SellingType, name: EnumSetting): readonly string[] {
  return defOf(type).limits[name] ?? OPTIONS[name];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const days = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365 ? value : null);

/** What was stored, made safe: every setting that is missing, unknown or not allowed for the type takes the type's default. */
export function readSellingSettings(type: SellingType, raw: unknown): SellingSettings {
  const { defaults } = defOf(type);
  if (!isRecord(raw)) return defaults;
  const out: SellingSettings = { ...defaults };
  for (const name of ENUM_SETTINGS) {
    const value = raw[name];
    if (typeof value === 'string' && allowedOptions(type, name).includes(value)) (out as unknown as Record<string, unknown>)[name] = value;
  }
  out.overdueDays = days(raw.overdueDays) ?? defaults.overdueDays;
  out.fixedDays = days(raw.fixedDays) ?? defaults.fixedDays;
  out.allowHoldUntilPaid = typeof raw.allowHoldUntilPaid === 'boolean' && defOf(type).defaults.allowHoldUntilPaid ? raw.allowHoldUntilPaid : defaults.allowHoldUntilPaid;
  return out;
}

export type CheckedSettings = { ok: true; settings: SellingSettings } | { ok: false; error: string };

const SETTING_WORDS: Record<EnumSetting, string> = { creditCheck: 'the credit check', noAccount: 'what to do with a customer without a credit account', overLimit: 'what to do over the limit', creditDays: 'the credit days', stockRelease: 'when stock is released', approval: 'approval', invoice: 'when the invoice is made', discounts: 'discounts' };

/** What the screen sent, for real: each choice must be one the type offers and the days must be whole numbers from 0 to 365. */
export function checkSellingInput(type: SellingType, raw: unknown): CheckedSettings {
  if (!isRecord(raw)) return { ok: false, error: 'The settings could not be read.' };
  const out: SellingSettings = { ...defOf(type).defaults };
  for (const name of ENUM_SETTINGS) {
    const value = raw[name];
    if (typeof value !== 'string' || !allowedOptions(type, name).includes(value)) return { ok: false, error: `Choose ${SETTING_WORDS[name]}.` };
    (out as unknown as Record<string, unknown>)[name] = value;
  }
  const overdue = days(raw.overdueDays);
  const fixed = days(raw.fixedDays);
  if (overdue === null) return { ok: false, error: 'The overdue days must be a whole number from 0 to 365.' };
  if (fixed === null) return { ok: false, error: 'The fixed credit days must be a whole number from 0 to 365.' };
  out.overdueDays = overdue;
  out.fixedDays = fixed;
  if (typeof raw.allowHoldUntilPaid !== 'boolean') return { ok: false, error: 'Say whether staff may hold a document until it is paid.' };
  if (raw.allowHoldUntilPaid && !defOf(type).defaults.allowHoldUntilPaid) return { ok: false, error: `${defOf(type).label} cannot be held until paid.` };
  out.allowHoldUntilPaid = raw.allowHoldUntilPaid;
  // A document that never waits for credit cannot be held over a limit it never checks.
  if (out.creditCheck === 'off' && out.overLimit === 'hold') out.overLimit = defOf(type).defaults.overLimit === 'hold' ? 'refuse' : out.overLimit;
  return { ok: true, settings: out };
}

/** The date a document falls due, in days after it is issued, under the type's credit-days rule. */
export function creditDaysFor(settings: SellingSettings, customerTermDays: number): number {
  if (settings.creditDays === 'on_issue') return 0;
  return settings.creditDays === 'fixed' ? settings.fixedDays : Math.max(0, Math.floor(customerTermDays));
}
