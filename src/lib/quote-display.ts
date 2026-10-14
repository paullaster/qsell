import { statusText } from '@/lib/quote-statuses';

/** An amount in a currency, with thousands separators and two decimals. */
export function money(value: number, currency: string): string {
  const amount = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${amount}`;
}

interface MarginFacts {
  grossMarginPercent: string | number;
  minimumMarginPercent: string | number;
}

/** True when the quote's margin is below the floor that was set when it was priced. */
export function missesMarginFloor(quote: MarginFacts): boolean {
  return Number(quote.grossMarginPercent) < Number(quote.minimumMarginPercent);
}

export type BadgeTone = 'warning' | 'success' | 'danger' | 'neutral';

/** How a quote's status is shown in the list: its words and its colour. */
export function quoteBadge(quote: {
  status: string;
  approvalStatus: string;
  expired: boolean;
  grossMarginPercent: string | number;
  minimumMarginPercent: string | number;
}): { label: string; tone: BadgeTone; waitingOnMargin: boolean } {
  const waitingOnMargin = missesMarginFloor(quote) && quote.approvalStatus === 'pending';
  const label = quote.expired ? 'expired' : statusText(quote.status);
  if (waitingOnMargin) return { label, tone: 'warning', waitingOnMargin };
  if (quote.status === 'accepted' || quote.status === 'converted') {
    return { label, tone: 'success', waitingOnMargin };
  }
  if (['rejected', 'expired', 'cancelled'].includes(quote.status)) {
    return { label, tone: 'danger', waitingOnMargin };
  }
  return { label, tone: 'neutral', waitingOnMargin };
}

/** The line under a status when an approval workflow owns the quote, or null. */
export function approvalNote(quote: {
  approvalManagedBy: string | null;
  approvalStatus: string;
}): string | null {
  if (quote.approvalManagedBy !== 'workflow') return null;
  switch (quote.approvalStatus) {
    case 'pending':
      return 'Waiting for approval in the Approvals inbox';
    case 'rejected':
      return 'Approval refused: reopen it from My requests';
    case 'draft':
      return 'Reopened: change it or send it for approval again';
    default:
      return null;
  }
}

/** Which row actions a quote offers, from its status and what the person may do. */
export interface QuoteRowPermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canApprove: boolean;
}

export function rowActions(
  quote: {
    status: string;
    approvalStatus: string;
    approvalManagedBy: string | null;
    customerEmail: string | null;
  },
  can: QuoteRowPermissions,
): {
  template: boolean;
  edit: boolean;
  approve: boolean;
  email: boolean;
  convert: boolean;
  missingEmail: boolean;
} {
  const open = quote.status === 'draft' || quote.status === 'approved';
  const hasEmail = quote.customerEmail !== null && quote.customerEmail !== '';
  return {
    template: can.canCreate,
    edit: can.canUpdate && (open || quote.status === 'pending_approval'),
    approve:
      can.canApprove &&
      quote.status === 'pending_approval' &&
      quote.approvalManagedBy !== 'workflow',
    email:
      can.canUpdate && open && !['pending', 'rejected', 'draft'].includes(quote.approvalStatus),
    convert: can.canApprove && quote.status === 'accepted',
    missingEmail: !hasEmail && open,
  };
}

/** True when there is something to show: not missing and not blank. */
export const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== '';

/** The parts that have text, joined with a separator. */
export const joinPresent = (parts: (string | null | undefined)[], separator: string): string =>
  parts.filter(hasText).join(separator);

/** The text, or the fallback when there is none. */
export const orElse = (text: string, fallback: string): string => (text === '' ? fallback : text);
