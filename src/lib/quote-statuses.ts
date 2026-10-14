/** The states a quote can be in, and "all" for no filter. */
export const QUOTE_STATUS_FILTERS = [
  'all',
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'converted',
  'expired',
  'cancelled',
] as const;

export type QuoteStatusFilter = (typeof QUOTE_STATUS_FILTERS)[number];

/** A status as people read it: "pending approval". */
export const statusText = (status: string): string => status.replaceAll('_', ' ');

export const statusFilterLabel = (status: string): string =>
  status === 'all' ? 'All statuses' : statusText(status);
