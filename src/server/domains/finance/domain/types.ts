export type AccountType = 'posting' | 'heading' | 'begin_total' | 'end_total' | 'total';
export type AccountCategory =
  | 'assets'
  | 'liabilities'
  | 'equity'
  | 'income'
  | 'cost_of_sales'
  | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type PeriodStatus = 'open' | 'soft_closed' | 'closed' | 'locked';
/** Where an account's postings may come from. */
export type PostingSource = 'manual' | 'engine_only';

/** One line of a journal as the engine receives it. Amounts are positive; one side only. */
export interface JournalLineInput {
  accountId: string;
  /** Exactly one of debit / credit is non-zero (document currency, text, up to 4 places). */
  debit: string;
  credit: string;
  description?: string | null;
  dimensionSetId?: string | null;
  /** ISO 4217 code of the amounts above. Defaults to the posting's currency. */
  currency?: string;
  /** Source sub-ledger entry for sub-ledger driven lines (customer, wallet, bank). */
  sourceLedger?: string | null;
  sourceEntryId?: string | null;
}

export interface PostingRequest {
  companyId: string;
  /** Unique per posting purpose: `<document kind>:<document id>:<purpose>`. */
  idempotencyKey: string;
  postingDate: string; // YYYY-MM-DD
  documentDate?: string;
  documentType: string;
  documentNo: string;
  description?: string;
  currency: string;
  /** Rate of document currency to base currency (text), "1" for base. */
  rate: string;
  rateSource: 'base' | 'rate_table' | 'manual' | 'document';
  lines: JournalLineInput[];
  /** Which hash chain (and lock) this register joins: a branch id, or "general". */
  chainKey: string;
  branchId?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  /** The surface that asked for this posting, set by the server entry point. */
  origin: PostingOrigin;
  source?: { type: string; id: string } | null;
  /** Set when this posting reverses another register. */
  reversalOf?: string | null;
  /** "post" requires the account to allow this source; "engine" may use control accounts. */
  postedBy: 'user' | 'engine';
}

export interface PostingOrigin {
  surface: string; // e.g. "finance/journals/batch-editor"
  action: string; // e.g. "post_batch"
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  permissionUsed?: string | null;
}

export interface Issue {
  code: string;
  message: string;
  line?: number;
}
