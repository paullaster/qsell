import type { KraConfigSource, KraMode } from '../types';

/**
 * Invoicing modules that can sign invoices. Each has its own switch, per scope. Quotes are
 * deliberately absent: a quote only ever produces a proforma, which is never signed. A quote
 * is signed only once it becomes a sales order, i.e. under `sales_order`.
 */
export const SIGNING_MODULES = [
  'ecommerce',
  'sales_order',
  'credit_sale',
  'pos_cash_sale',
] as const;
export type SigningModule = (typeof SIGNING_MODULES)[number];

export const SIGNING_MODULE_LABELS: Record<SigningModule, string> = {
  ecommerce: 'Ecommerce (customer-facing store)',
  sales_order: 'Sales orders',
  credit_sale: 'Credit sales',
  pos_cash_sale: 'POS cash sales',
};

export function isSigningModule(value: string): value is SigningModule {
  return (SIGNING_MODULES as readonly string[]).includes(value);
}

/** Per-module switches stored on a config row. Absent key: not set at that level. */
export type ModuleSigning = Partial<Record<SigningModule, boolean>>;

/**
 * What can go through the generic signing path. `proforma` is never signed whatever the
 * settings. Credit notes are deliberately absent: they have their own flow with their own
 * explicit policies, so they cannot be sent through here by accident.
 */
export type SigningDocumentType = 'tax_invoice' | 'proforma';

export const SIGNING_DOCUMENT_TYPES: readonly SigningDocumentType[] = ['tax_invoice', 'proforma'];

/** Where a document came from. Part of its identity in the signing log. */
export type SigningSourceKind = 'order' | 'quote' | 'pos_sale' | 'credit_note';

/** The signing outcome as mirrored onto the records a document came from. */
export type KraDocumentStatus = 'skipped' | 'failed' | 'transmitted' | 'deferred';

export type SigningGate =
  | 'document'
  | 'scope'
  | 'mode'
  | 'mode_signing_switch'
  | 'module_switch'
  | 'customer_flag'
  | 'readiness'
  // credit notes
  | 'original_invoice'
  | 'original_scope'
  | 'original_mode';

export interface GateTrace {
  gate: SigningGate;
  result: 'pass' | 'skip' | 'fail';
  /** The value the gate read, e.g. `true` for a switch or `"etims"` for the mode. */
  value: unknown;
  /** Where the value came from, so a decision can be explained after the fact. */
  source: string;
  detail: string;
}

/**
 * sign   — it is being signed.
 * skip   — deliberately not signed.
 * fail   — signing was wanted but something it needs is missing or broken.
 * defer  — cannot be decided yet because it waits on another document (a credit note whose
 *          original invoice is not signed yet). It is processed again when that resolves.
 */
export type SigningOutcome = 'sign' | 'skip' | 'fail' | 'defer';

/** Documents that appear in the signing log. Credit notes have their own policy, not the gates. */
export type LoggedDocumentType = SigningDocumentType | 'credit_note';

export type SigningReason =
  | 'SIGN'
  | 'PROFORMA_NEVER_SIGNED'
  | 'KRA_NOT_CONFIGURED'
  | 'SIGNING_NOT_ENABLED_FOR_MODE'
  | 'ORIGINAL_NOT_SIGNED'
  | 'ORIGINAL_NOT_YET_SIGNED'
  | 'MODULE_DISABLED'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'CUSTOMER_OPTED_OUT'
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_INACTIVE'
  | 'BRANCH_CONFIG_MISSING'
  | 'COMPANY_CONFIG_MISSING'
  | 'CONFIG_DISABLED'
  | 'CONFIG_INCOMPLETE'
  | 'MODE_MISMATCH'
  | 'ITEMS_NOT_REGISTERED'
  | 'TIMS_SIGNING_UNAVAILABLE'
  | 'TRANSMISSION_FAILED'
  | 'UNEXPECTED_ERROR';

export interface SigningRequest {
  companyId: string;
  /** The branch the document is issued from; null when it is not tied to one. */
  branchId?: string | null;
  module: SigningModule;
  documentType: SigningDocumentType;
  /**
   * The customer's "transmit invoices to KRA" flag. Null when there is no customer profile:
   * the default is to sign, so only an explicit false opts out.
   */
  customerFlag: boolean | null;
}

export interface SigningDecision {
  outcome: SigningOutcome;
  reason: SigningReason;
  /** Which config the decision was made from. Null when no scope was reached. */
  scope: KraConfigSource | null;
  /** Set when scope is 'branch'. */
  branchId: string | null;
  mode: KraMode | null;
  /** Every gate evaluated, in order, up to and including the one that stopped the document. */
  gates: GateTrace[];
  /** The settings that were in force, kept so the decision stays explainable if they change. */
  settings: Record<string, unknown>;
}
