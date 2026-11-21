import { whenOrBlank } from '@/lib/business-time-format';
import type { CompanyProfile } from '@/server/ports/communications';
import type { ShiftReport } from './shift-service';

/** Everything printed on a shift report: plain, already-formatted text, so the layout can change without touching the figures. */
export interface ShiftReportDocument {
  company: CompanyProfile;
  /** "X REPORT" while the shift is open (figures so far), "Z REPORT" once it is closed. */
  title: string;
  /** The Z number, or "Shift so far". */
  number: string;
  status: string;
  meta: [string, string][];
  /** Label, amount text, whether it is a total line. */
  cash: { label: string; value: string; strong: boolean }[];
  other: { label: string; value: string }[];
  counted: { label: string; value: string }[];
  movements: { kind: string; amount: string; reason: string; by: string; at: string }[];
  note: string | null;
  printedOn: string;
}

export const kes = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (amount: number): string => `${amount > 0 ? '+' : ''}${kes(amount)}`;

/** The report as a document to print: the same figures the screen shows, written once. Pure: the zone and the time of printing are given. */
export function buildShiftReportDocument(report: ShiftReport, company: CompanyProfile, timeZone: string, now: Date): ShiftReportDocument {
  const open = report.status !== 'closed';
  const cash: ShiftReportDocument['cash'] = [
    { label: 'Opening float', value: kes(report.openingFloat), strong: false },
    { label: 'Cash sales', value: kes(report.cashSales), strong: false },
    { label: 'Cash put in', value: kes(report.paidIn), strong: false },
    ...(report.takings.cashRefunds > 0 ? [{ label: 'Cash handed back for returns', value: `-${kes(report.takings.cashRefunds)}`, strong: false }] : []),
    { label: 'Cash taken out', value: `-${kes(report.paidOut)}`, strong: false },
    { label: 'The till should hold', value: kes(report.expectedCash), strong: true },
    ...(report.declaredCash === null ? [] : [{ label: 'Counted at the close', value: kes(report.declaredCash), strong: true }]),
    ...(report.variance === null ? [] : [{ label: 'Difference', value: signed(report.variance), strong: true }]),
  ];
  const other = [
    { label: 'Sales rung up', value: String(report.takings.count) },
    ...(report.takings.mobileMoney > 0 ? [{ label: 'Taken by M-Pesa (not in the till)', value: kes(report.takings.mobileMoney) }] : []),
    ...(report.takings.card > 0 ? [{ label: 'Taken by card (not in the till)', value: kes(report.takings.card) }] : []),
    ...(report.takings.refunds > 0 ? [{ label: 'Returned to customers (all ways)', value: kes(report.takings.refunds) }] : []),
  ];
  const meta: [string, string][] = [
    ['Till', `${report.registerName}, ${report.branchName}`],
    ['Opened', `${whenOrBlank(report.openedAt, timeZone)} by ${report.openedBy}`],
    ...(report.closedAt === null ? [] : [['Closed', `${whenOrBlank(report.closedAt, timeZone)} by ${report.closedBy ?? ''}`] as [string, string]]),
  ];
  return {
    company,
    title: open ? 'X REPORT' : 'Z REPORT',
    number: open ? 'Shift so far' : (report.zNumber ?? ''),
    status: open ? 'Open' : 'Closed',
    meta,
    cash,
    other,
    counted: report.closingCounted.map((c) => ({ label: `${c.value.toLocaleString('en-KE')} x ${String(c.count)}`, value: kes(c.value * c.count) })),
    movements: report.movements.map((m) => ({ kind: m.kind === 'paid_in' ? 'In' : 'Out', amount: kes(m.amount), reason: m.reason, by: m.by, at: whenOrBlank(m.at, timeZone) })),
    note: report.varianceReason === null ? null : `Reason for the difference: ${report.varianceReason}`,
    printedOn: whenOrBlank(now, timeZone),
  };
}
