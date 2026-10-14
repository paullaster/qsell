/**
 * The words and colours for the states of receipts, cheques and refunds. Plain data shared by the
 * server (which offers them to a filter picker) and the screens (which print them). Pure.
 */
export type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';
export interface StatusInfo {
  label: string;
  tone: Tone;
}

export const RECEIPT_STATUS: Record<string, StatusInfo> = {
  draft: { label: 'Draft', tone: 'amber' },
  posted: { label: 'Posted', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const CHEQUE_STATUS: Record<string, StatusInfo> = {
  received: { label: 'Cheque received', tone: 'sky' },
  deposited: { label: 'Cheque deposited', tone: 'amber' },
  cleared: { label: 'Cheque cleared', tone: 'green' },
  bounced: { label: 'Cheque bounced', tone: 'red' },
};

export const REFUND_STATUS: Record<string, StatusInfo> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, not paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

const UNKNOWN: StatusInfo = { label: '', tone: 'gray' };

/** The label and colour of a state; an unknown state shows as itself, in grey. */
export function statusInfo(table: Record<string, StatusInfo>, state: string | null | undefined): StatusInfo {
  if (state === null || state === undefined || state === '') return UNKNOWN;
  return Object.hasOwn(table, state) ? table[state] : { label: state, tone: 'gray' };
}

export const statusChoices = (table: Record<string, StatusInfo>): { id: string; label: string }[] =>
  Object.entries(table).map(([id, info]) => ({ id, label: info.label }));
