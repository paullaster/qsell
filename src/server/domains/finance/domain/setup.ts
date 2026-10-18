/** Which account does this kind of thing post to? A lookup in data, never in code. */
export type GeneralPurpose =
  | 'sales'
  | 'sales_returns'
  | 'sales_discount'
  | 'cogs'
  | 'inventory_adjustment'
  | 'inventory'
  | 'inventory_clearing';

export type CustomerPurpose =
  | 'receivables'
  | 'customer_deposits'
  | 'refunds_payable'
  | 'payment_discount'
  | 'write_off'
  | 'rounding'
  | 'fx_gain'
  | 'fx_loss'
  | 'service_charge'
  | 'rebate_expense'
  | 'gift_card_liability'
  | 'loyalty_provision'
  | 'credit_forfeit'
  | 'credit_adjustment';

export interface GeneralSetupRow {
  id: string;
  businessGroup: string;
  productGroup: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  accounts: Record<GeneralPurpose, string | null>;
}

export interface SetupTrace {
  table: string;
  purpose: string;
  looked: { key: string; result: 'chosen' | 'not_effective' | 'no_account' | 'no_row' }[];
  rowId: string | null;
}

export class SetupMissingError extends Error {
  constructor(
    message: string,
    readonly trace: SetupTrace,
  ) {
    super(message);
  }
}

const inForce = (r: { effectiveFrom: string; effectiveTo: string | null }, date: string) =>
  r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo);

/**
 * Picks the account for a business group × product group on a date. The newest row in force
 * wins; a missing row or an empty account is a hard error that names the setup to create.
 */
export function resolveGeneral(
  rows: GeneralSetupRow[],
  businessGroup: string,
  productGroup: string,
  purpose: GeneralPurpose,
  date: string,
): { accountId: string; trace: SetupTrace } {
  const key = `${businessGroup} × ${productGroup}`;
  const trace: SetupTrace = { table: 'general_posting_setup', purpose, looked: [], rowId: null };
  const matching = rows
    .filter((r) => r.businessGroup === businessGroup && r.productGroup === productGroup)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (matching.length === 0) {
    trace.looked.push({ key, result: 'no_row' });
    throw new SetupMissingError(
      `Posting setup is missing for ${key}. Add it under Finance → Posting setup.`,
      trace,
    );
  }
  const row = matching.find((r) => inForce(r, date));
  if (!row) {
    trace.looked.push({ key, result: 'not_effective' });
    throw new SetupMissingError(`Posting setup for ${key} is not in force on ${date}.`, trace);
  }
  const accountId = row.accounts[purpose];
  if (accountId === null) {
    trace.looked.push({ key, result: 'no_account' });
    throw new SetupMissingError(
      `Posting setup for ${key} has no account for "${purpose}". Set one under Finance → Posting setup.`,
      trace,
    );
  }
  trace.looked.push({ key, result: 'chosen' });
  trace.rowId = row.id;
  return { accountId, trace };
}

export interface CustomerGroupRow {
  id: string;
  code: string;
  accounts: Record<CustomerPurpose, string | null>;
}

export function resolveCustomer(
  groups: CustomerGroupRow[],
  groupCode: string,
  purpose: CustomerPurpose,
): { accountId: string; trace: SetupTrace } {
  const trace: SetupTrace = { table: 'customer_posting_groups', purpose, looked: [], rowId: null };
  const row = groups.find((g) => g.code === groupCode);
  if (!row) {
    trace.looked.push({ key: groupCode, result: 'no_row' });
    throw new SetupMissingError(
      `Customer posting group "${groupCode}" does not exist. Add it under Finance → Posting setup.`,
      trace,
    );
  }
  const accountId = row.accounts[purpose];
  if (accountId === null) {
    trace.looked.push({ key: groupCode, result: 'no_account' });
    throw new SetupMissingError(
      `Customer posting group "${groupCode}" has no account for "${purpose}".`,
      trace,
    );
  }
  trace.looked.push({ key: groupCode, result: 'chosen' });
  trace.rowId = row.id;
  return { accountId, trace };
}
