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
export const APPROVAL_RULES = ['workflow', 'never'] as const;
export const INVOICE_TIMINGS = ['with_document', 'later'] as const;
export const DISCOUNT_RULES = ['allowed', 'not_allowed'] as const;
/** Whether staff may type a discount of their own while selling: nowhere, at every branch, or only at the branches chosen. */
export const MANUAL_DISCOUNT_RULES = ['off', 'all_branches', 'selected_branches'] as const;
/** The most branches one setting can name. */
export const MANUAL_DISCOUNT_BRANCH_LIMIT = 100;

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
  /** Whether staff may offer a discount of their own at the point of selling, and at which branches. Needs the document's discount permission too. */
  manualDiscount: (typeof MANUAL_DISCOUNT_RULES)[number];
  /** For `selected_branches`: the branches where it is offered. */
  manualDiscountBranches: string[];
  /** When the invoice is made with the document but approval held it, make it automatically once it is approved (otherwise staff raise it). */
  invoiceAfterApproval: boolean;
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
  manualDiscount: MANUAL_DISCOUNT_RULES,
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
    pay_first: { label: 'Require payment first', description: 'A customer without a credit account may buy, but the stock is held until they have paid' },
  },
  overLimit: {
    refuse: { label: 'Refuse', description: 'The document is not accepted' },
    hold: { label: 'Ask for approval', description: 'The company\'s approval workflows decide: the document waits, with its stock reserved, until approved or rejected; with no workflow that covers it, it is refused' },
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
    workflow: { label: 'By the company\'s approval workflows', description: 'Waits only when a workflow matches (price floors, size, the customer\'s limit)' },
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
  manualDiscount: {
    off: { label: 'Not offered', description: 'Nobody types a discount of their own' },
    all_branches: { label: 'At every branch', description: 'People with the discount permission may offer a discount at any branch' },
    selected_branches: { label: 'Only at the branches chosen', description: 'People with the discount permission may offer a discount only while selling at the branches listed below' },
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

const base: SellingSettings = { creditCheck: 'limit', overdueDays: 30, noAccount: 'allow', overLimit: 'hold', creditDays: 'customer', fixedDays: 30, stockRelease: 'on_delivery', approval: 'workflow', invoice: 'later', discounts: 'allowed', manualDiscount: 'off', manualDiscountBranches: [], invoiceAfterApproval: true, allowHoldUntilPaid: true };

/** Only the counter offers a manual discount for now; the other selling points follow. */
const NO_MANUAL_DISCOUNT: SellingTypeDef['limits'] = { manualDiscount: ['off'] };

export const SELLING_TYPE_DEFS: readonly SellingTypeDef[] = [
  { type: 'sales_order', label: 'Sales orders', description: 'An order staff take for later collection or delivery.', defaults: base, limits: NO_MANUAL_DISCOUNT },
  { type: 'credit_sale', label: 'Credit sales', description: 'A sale to a customer\'s account, invoiced at once.', defaults: { ...base, noAccount: 'refuse', invoice: 'with_document' }, limits: { ...NO_MANUAL_DISCOUNT, noAccount: ['refuse'] } },
  { type: 'sales_invoice', label: 'Sales invoices', description: 'A sale invoiced directly, with no sales order.', defaults: { ...base, stockRelease: 'on_issue', invoice: 'with_document' }, limits: { ...NO_MANUAL_DISCOUNT, invoice: ['with_document'] } },
  { type: 'pos_cash_sale', label: 'Cash sales', description: 'A counter sale paid at once, inside a shift.', defaults: { ...base, creditCheck: 'off', noAccount: 'allow', overLimit: 'refuse', creditDays: 'on_issue', stockRelease: 'on_issue', approval: 'never', invoice: 'with_document', allowHoldUntilPaid: false }, limits: { manualDiscount: MANUAL_DISCOUNT_RULES, creditCheck: ['off'], noAccount: ['allow'], overLimit: ['refuse'], creditDays: ['on_issue'], stockRelease: ['on_issue'], approval: ['never'], invoice: ['with_document'] } },
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A list of branch ids, each once; null when it is not one. */
const branchIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > MANUAL_DISCOUNT_BRANCH_LIMIT) return null;
  const ids = value.filter((v): v is string => typeof v === 'string' && UUID.test(v)).map((v) => v.toLowerCase());
  return ids.length === value.length ? [...new Set(ids)] : null;
};
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
  out.manualDiscountBranches = branchIds(raw.manualDiscountBranches) ?? [];
  out.overdueDays = days(raw.overdueDays) ?? defaults.overdueDays;
  out.fixedDays = days(raw.fixedDays) ?? defaults.fixedDays;
  out.invoiceAfterApproval = typeof raw.invoiceAfterApproval === 'boolean' ? raw.invoiceAfterApproval : defaults.invoiceAfterApproval;
  out.allowHoldUntilPaid = typeof raw.allowHoldUntilPaid === 'boolean' && defOf(type).defaults.allowHoldUntilPaid ? raw.allowHoldUntilPaid : defaults.allowHoldUntilPaid;
  return out;
}

export type CheckedSettings = { ok: true; settings: SellingSettings } | { ok: false; error: string };

const SETTING_WORDS: Record<EnumSetting, string> = { creditCheck: 'the credit check', noAccount: 'what to do with a customer without a credit account', overLimit: 'what to do over the limit', creditDays: 'the credit days', stockRelease: 'when stock is released', approval: 'approval', invoice: 'when the invoice is made', discounts: 'discounts', manualDiscount: 'whether staff may offer a discount of their own' };

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
  const chosen = branchIds(raw.manualDiscountBranches ?? []);
  if (chosen === null) return { ok: false, error: 'The branches for the discount could not be read.' };
  if (out.manualDiscount === 'selected_branches' && chosen.length === 0) return { ok: false, error: 'Choose at least one branch where a discount may be offered, or offer it at every branch.' };
  out.manualDiscountBranches = out.manualDiscount === 'selected_branches' ? chosen : [];
  if (typeof raw.invoiceAfterApproval !== 'boolean') return { ok: false, error: 'Say whether the invoice is made automatically once the document is approved.' };
  out.invoiceAfterApproval = raw.invoiceAfterApproval;
  if (typeof raw.allowHoldUntilPaid !== 'boolean') return { ok: false, error: 'Say whether staff may hold a document until it is paid.' };
  if (raw.allowHoldUntilPaid && !defOf(type).defaults.allowHoldUntilPaid) return { ok: false, error: `${defOf(type).label} cannot be held until paid.` };
  out.allowHoldUntilPaid = raw.allowHoldUntilPaid;
  // A document that never waits for credit cannot be held over a limit it never checks.
  if (out.creditCheck === 'off' && out.overLimit === 'hold') out.overLimit = defOf(type).defaults.overLimit === 'hold' ? 'refuse' : out.overLimit;
  return { ok: true, settings: out };
}

/**
 * When an order's reserved stock is issued, decided at placing and kept on the order: the document's own "Hold until paid" (where the
 * kind allows it), a customer without a credit account under "Require payment first", otherwise the kind's setting.
 */
export function stockReleaseFor(settings: SellingSettings, order: { holdUntilPaid: boolean; hasCreditAccount: boolean }): (typeof STOCK_RELEASES)[number] {
  if (order.holdUntilPaid && settings.allowHoldUntilPaid) return 'on_payment';
  if (settings.noAccount === 'pay_first' && !order.hasCreditAccount) return 'on_payment';
  return settings.stockRelease;
}

/** The date a document falls due, in days after it is issued, under the type's credit-days rule. */
export function creditDaysFor(settings: SellingSettings, customerTermDays: number): number {
  if (settings.creditDays === 'on_issue') return 0;
  return settings.creditDays === 'fixed' ? settings.fixedDays : Math.max(0, Math.floor(customerTermDays));
}

/** Whether the document type lets staff at this branch type a discount (the person's permission is checked beside this). A document that allows no discounts never does. */
export function manualDiscountOffered(settings: SellingSettings, branchId: string | null): boolean {
  if (settings.discounts === 'not_allowed' || settings.manualDiscount === 'off') return false;
  if (settings.manualDiscount === 'all_branches') return true;
  return branchId !== null && settings.manualDiscountBranches.includes(branchId.toLowerCase());
}
