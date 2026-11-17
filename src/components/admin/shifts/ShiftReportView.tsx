'use client';

import type { ShiftReport } from '@/server/domains/selling/shifts/shift-service';
import { Chip, buttonClass } from '@/components/ui/screen-kit';

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string): string => new Date(iso).toLocaleString();

/** A shift's report: the X report while it is open (figures so far), the Z report once it is closed (kept as it closed, with its number). */
export function ShiftReportView({ report }: { report: ShiftReport }) {
  const open = report.status === 'open';
  const row = (label: string, value: string, strong = false) => (
    <div key={label} className={`flex justify-between gap-3 ${strong ? 'font-semibold text-fg-strong' : ''}`}><dt>{label}</dt><dd className="font-mono">{value}</dd></div>
  );
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm print:border-0" aria-label={open ? 'X report' : 'Z report'} data-testid={open ? 'x-report' : 'z-report'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-fg-strong">{open ? 'X report (shift so far)' : `Z report ${report.zNumber ?? ''}`}</h3>
        <div className="flex items-center gap-2 print:hidden">
          <Chip tone={open ? 'amber' : 'green'}>{open ? 'Open' : 'Closed'}</Chip>
          <button type="button" className={buttonClass} onClick={() => window.print()}>Print</button>
        </div>
      </div>
      <p className="text-fg-muted">{report.registerName}, {report.branchName}. Opened by {report.openedBy} on {when(report.openedAt)}{report.closedAt === null ? '' : `; closed by ${report.closedBy ?? ''} on ${when(report.closedAt)}`}.</p>
      <dl className="space-y-1">
        {row('Opening float', money(report.openingFloat))}
        {row('Cash sales', money(report.cashSales))}
        {row('Cash put in', money(report.paidIn))}
        {report.takings.cashRefunds > 0 ? row('Cash handed back for returns', `−${money(report.takings.cashRefunds)}`) : null}
        {row('Cash taken out', `−${money(report.paidOut)}`)}
        {row('The till should hold', money(report.expectedCash), true)}
        {report.takings.mobileMoney > 0 ? row('Also taken by M-Pesa (not in the till)', money(report.takings.mobileMoney)) : null}
        {report.takings.card > 0 ? row('Also taken by card (not in the till)', money(report.takings.card)) : null}
        {report.declaredCash === null ? null : row('Counted at the close', money(report.declaredCash), true)}
        {report.variance === null ? null : row('Difference', `${report.variance > 0 ? '+' : ''}${money(report.variance)}`, true)}
      </dl>
      {report.varianceReason === null ? null : <p className="text-fg-muted">Reason for the difference: {report.varianceReason}</p>}
      {report.movements.length === 0 ? null : (
        <div>
          <h4 className="font-semibold text-fg-strong">Cash in and out</h4>
          <ul className="mt-1 space-y-0.5" data-testid="shift-movements">{report.movements.map((m) => <li key={m.at + m.reason}>{m.kind === 'paid_in' ? 'In' : 'Out'} {money(m.amount)}: {m.reason} ({m.by}, {when(m.at)})</li>)}</ul>
        </div>
      )}
      {report.closingCounted.length === 0 ? null : <p className="text-fg-muted">Counted: {report.closingCounted.map((c) => `${String(c.count)} × ${c.value.toLocaleString()}`).join(', ')}.</p>}
    </section>
  );
}
