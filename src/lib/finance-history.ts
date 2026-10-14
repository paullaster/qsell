/**
 * Small pieces of wording shared by the receipt and refund pages. Pure.
 */
export const has = (value: string | null | undefined): value is string => value !== null && value !== undefined && value !== '';

/** A value from a loose record, or a dash when it is missing or empty. */
export const recordValue = (record: Readonly<Record<string, string>>, key: string): string => (Object.hasOwn(record, key) && record[key] !== '' ? record[key] : '—');

/** "cheque_bounced" -> "cheque bounced". */
export const plain = (text: string): string => text.replace(/_/g, ' ');

export interface HistoryEvent {
  event: string;
  from: string | null;
  to: string | null;
  at: string;
  by: string;
  surface: string | null;
  permission: string | null;
  reasonCode: string | null;
  reasonText: string | null;
}

/** The headline of a history entry: what happened, and the move between states when there was one. */
export function historyHeadline(e: Pick<HistoryEvent, 'event' | 'from' | 'to'>, arrow = ' → '): string {
  const moved = has(e.to) && e.to !== e.from ? `${arrow}${plain(e.to)}` : '';
  return `${plain(e.event)}${moved}`;
}

/** Who did it, when, from where and with which permission. */
export function historyDetail(e: Pick<HistoryEvent, 'at' | 'by' | 'surface' | 'permission'>, formatTime: (iso: string) => string): string {
  return [
    `${e.by} · ${formatTime(e.at)}`,
    has(e.surface) ? ` · from ${e.surface}` : '',
    has(e.permission) ? ` · with ${e.permission}` : '',
  ].join('');
}

/** The reason given, with its comment. */
export function historyReason(e: Pick<HistoryEvent, 'reasonCode' | 'reasonText'>): string {
  if (!has(e.reasonCode)) return '';
  return has(e.reasonText) ? `${plain(e.reasonCode)}: ${e.reasonText}` : plain(e.reasonCode);
}

export const submitMessage = (status: string): string => (status === 'approved' ? 'Approved: the money is set aside, ready to pay.' : 'Sent for approval.');
