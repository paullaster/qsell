export type SigningOutcomeId = 'sign' | 'skip' | 'fail' | 'defer';

export const OUTCOME_LABEL: Record<SigningOutcomeId, string> = {
  sign: 'Signed',
  skip: 'Not signed',
  fail: 'Failed',
  defer: 'Waiting on original',
};

/** What the log can be narrowed to; no choice means every result. */
export const SIGNING_OUTCOME_CHOICES: readonly { id: SigningOutcomeId; label: string }[] = [
  { id: 'sign', label: OUTCOME_LABEL.sign },
  { id: 'skip', label: OUTCOME_LABEL.skip },
  { id: 'fail', label: OUTCOME_LABEL.fail },
  { id: 'defer', label: OUTCOME_LABEL.defer },
];

export const isOutcome = (value: string | undefined): value is SigningOutcomeId => SIGNING_OUTCOME_CHOICES.some((c) => c.id === value);

export const REASON_TEXT: Record<string, string> = {
  SIGN: 'Signed with KRA',
  PROFORMA_NEVER_SIGNED: 'Proforma invoices are never signed',
  KRA_NOT_CONFIGURED: 'KRA is not configured',
  SIGNING_NOT_ENABLED_FOR_MODE: 'Signing is not enabled for the mode',
  ORIGINAL_NOT_SIGNED: 'The original invoice was not signed, so there is nothing to reverse',
  ORIGINAL_NOT_YET_SIGNED: 'Waiting for the original invoice to be signed',
  MODULE_DISABLED: 'Signing is off for this module',
  UNSUPPORTED_DOCUMENT_TYPE: 'This document type does not go through this path',
  CUSTOMER_OPTED_OUT: 'The customer opted out',
  BRANCH_NOT_FOUND: 'Branch not found',
  BRANCH_INACTIVE: 'Branch is inactive',
  BRANCH_CONFIG_MISSING: 'The independent branch has no KRA configuration',
  COMPANY_CONFIG_MISSING: 'No company KRA configuration',
  CONFIG_DISABLED: 'The KRA configuration is disabled',
  CONFIG_INCOMPLETE: 'The KRA configuration is incomplete',
  MODE_MISMATCH: 'The mode does not match',
  ITEMS_NOT_REGISTERED: 'Items are not registered with KRA',
  TIMS_SIGNING_UNAVAILABLE: 'TIMS signing is not available yet',
  TRANSMISSION_FAILED: 'KRA did not accept the invoice',
  UNEXPECTED_ERROR: 'Unexpected error',
};

export const reasonWords = (reason: string): string => REASON_TEXT[reason] ?? reason;
