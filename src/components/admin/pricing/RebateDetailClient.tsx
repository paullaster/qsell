'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import {
  rebateStatementAction,
  rebateStatusAction,
  requestRebateSettlementAction,
  type RebateDetail,
} from '@/server/domains/pricing/retrospective-actions';
import type { Statement } from '@/server/domains/pricing/rebate-config-service';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  Notice,
  PageHeader,
  When,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { money } from './DiscountsClient';
import { RebateForm } from './RebateForm';
import { rebateChip } from './RebatesClient';

const EVENTS: Record<string, string> = {
  'pricing.rebate_program_created': 'Created as a draft',
  'pricing.rebate_program_updated': 'Changed',
  'pricing.rebate_program_activated': 'Put in force',
  'pricing.rebate_program_paused': 'Paused',
  'pricing.rebate_program_retired': 'Retired',
};

const SETTLEMENT_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = {
  settled: 'green',
  pending: 'amber',
  rejected: 'red',
  cancelled: 'grey',
};

export function RebateDetailClient({
  detail,
  lookups,
  canManage,
}: {
  detail: RebateDetail;
  lookups: DiscountLookups;
  canManage: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const p = detail.program;
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<'active' | 'paused' | 'retired' | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState(detail.periods[0]?.key ?? p.current.key);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [paying, setPaying] = useState<{ customerId: string; name: string; amount: number } | null>(
    null,
  );

  const periodOptions = detail.periods.some((x) => x.key === p.current.key)
    ? detail.periods
    : [{ key: p.current.key, label: p.current.label, ended: false }, ...detail.periods];
  const retired = p.status === 'retired';
  const canEdit = canManage && (p.status === 'draft' || p.status === 'paused');

  useEffect(() => {
    let live = true;
    void rebateStatementAction(p.id, period).then((r) => {
      if (live) setStatement(r.ok ? r.data : null);
    });
    return () => {
      live = false;
    };
  }, [p.id, period, detail.settlements.length]);

  const changeStatus = async () => {
    if (!action) return;
    setBusy(true);
    setMessage(null);
    const r = await rebateStatusAction(p.id, action, reason);
    setBusy(false);
    if (!r.ok) { setMessage({ kind: 'error', text: r.error }); return; }
    setMessage({
      kind: 'ok',
      text:
        action === 'active'
          ? 'The programme is in force. Orders now count towards it.'
          : action === 'paused'
            ? 'The programme is paused. Orders stop counting; totals so far are kept.'
            : 'The programme is retired.',
    });
    setAction(null);
    setReason({ code: '', text: '' });
    router.refresh();
  };

  const pay = async () => {
    if (!paying) return;
    setBusy(true);
    setMessage(null);
    const r = await requestRebateSettlementAction(
      { programId: p.id, customerId: paying.customerId, periodKey: period },
      reason,
    );
    setBusy(false);
    if (!r.ok) { setMessage({ kind: 'error', text: r.error }); return; }
    setMessage({
      kind: 'ok',
      text: r.data.pending
        ? (r.data.message ?? 'Sent for approval.')
        : `${paying.name} has been credited.`,
    });
    setPaying(null);
    setReason({ code: '', text: '' });
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/pricing/rebates"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← All rebates
        </Link>
      </p>
      <PageHeader
        title={p.name}
        actions={
          canManage && !retired ? (
            <>
              {p.status !== 'active' ? (
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => setAction('active')}
                >
                  Put in force
                </button>
              ) : null}
              {canEdit ? (
                <button type="button" className={buttonClass} onClick={() => setEditing((e) => !e)}>
                  {editing ? 'Close editor' : 'Change'}
                </button>
              ) : null}
              {p.status === 'active' ? (
                <button type="button" className={buttonClass} onClick={() => setAction('paused')}>
                  Pause
                </button>
              ) : null}
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => setAction('retired')}
              >
                Retire
              </button>
            </>
          ) : null
        }
      >
        {p.code} · version {p.version}
      </PageHeader>
      <Notice message={message} />

      <section aria-label="Summary" className={`${cardClass} space-y-2`}>
        <div className="flex flex-wrap items-center gap-2">{rebateChip(p)}</div>
        <p className="text-sm text-fg-strong">{p.summary}</p>
        {p.status === 'active' ? (
          <p className="text-xs text-fg-muted">
            A programme in force cannot be edited. Pause it, change it, then put it back in force.
          </p>
        ) : null}
      </section>

      {action ? (
        <section aria-label="Confirm" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            {action === 'active'
              ? 'Put this programme in force? Orders from now on count towards it.'
              : action === 'paused'
                ? 'Pause this programme? Orders stop counting; what is counted so far is kept.'
                : 'Retire this programme for good? Totals stay readable and payable.'}
          </p>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={action === 'retired' ? dangerButtonClass : primaryButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void changeStatus()}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setAction(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {editing && canEdit ? (
        <RebateForm
          mode="edit"
          initial={p}
          lookups={lookups}
          names={detail.names}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setMessage({ kind: 'ok', text: 'Saved.' });
            router.refresh();
          }}
        />
      ) : null}

      <section aria-label="Statement" className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-bold text-fg-strong">Statement</h2>
          <div>
            <label htmlFor={`${uid}-period`} className="text-xs text-fg-muted">
              Period
            </label>
            <select
              id={`${uid}-period`}
              className={`${fieldClass} w-48`}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              {periodOptions.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                  {x.ended ? '' : ' (running)'}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!statement ? (
          <p className="text-sm text-fg-muted" role="status">
            Loading…
          </p>
        ) : statement.rows.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing has been counted in this period yet.</p>
        ) : (
          <>
            <p className="text-xs text-fg-muted">
              {statement.ended
                ? 'This period has ended, so the totals are final and can be paid.'
                : 'This period is still running. Totals can still grow, so nothing can be paid yet.'}
              {statement.truncated ? ' Showing the biggest customers only.' : ''}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-fg-muted">
                    <th className="py-2 pr-3 font-semibold">Customer</th>
                    <th className="py-2 pr-3 text-right font-semibold">Bought</th>
                    <th className="py-2 pr-3 text-right font-semibold">Rate</th>
                    <th className="py-2 pr-3 text-right font-semibold">Rebate</th>
                    <th className="py-2 font-semibold">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((r) => (
                    <tr key={r.customerId} className="border-b border-line/60 align-top">
                      <td className="py-2 pr-3">
                        {r.customerName}
                        {r.next ? (
                          <span className="block text-xs text-fg-muted">
                            {money(r.next.needed)} more reaches {r.next.percent}%
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">{money(r.basis)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{r.percent}%</td>
                      <td className="py-2 pr-3 text-right font-mono">{money(r.amount)}</td>
                      <td className="py-2 text-right">
                        {r.settlement ? (
                          <Chip tone={SETTLEMENT_TONE[r.settlement.status] ?? 'grey'}>
                            {r.settlement.status === 'settled' ? 'Paid' : 'Waiting for approval'}
                          </Chip>
                        ) : canManage && statement.ended && r.amount > 0 ? (
                          <button
                            type="button"
                            className={buttonClass}
                            onClick={() =>
                              setPaying({
                                customerId: r.customerId,
                                name: r.customerName,
                                amount: r.amount,
                              })
                            }
                          >
                            Pay
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-sm font-semibold">
                    <td className="py-2 pr-3">Total</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {money(statement.totalBasis)}
                    </td>
                    <td />
                    <td className="py-2 pr-3 text-right font-mono">
                      {money(statement.totalAmount)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
        {paying ? (
          <div
            role="group"
            aria-label="Pay rebate"
            className="space-y-3 rounded-lg border border-line p-3"
          >
            <p className="text-sm text-fg-strong">
              Credit <strong>{paying.name}</strong> with {money(paying.amount)} for{' '}
              {statement?.label}? It reduces what they owe, oldest invoice first.
            </p>
            <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || !reason.code}
                onClick={() => void pay()}
              >
                {busy ? 'Working…' : 'Pay the rebate'}
              </button>
              <button type="button" className={buttonClass} onClick={() => setPaying(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label="Payments" className={`${cardClass} space-y-2`}>
        <h2 className="text-sm font-bold text-fg-strong">Payments</h2>
        {detail.settlements.length === 0 ? (
          <p className="text-sm text-fg-muted">No rebate has been paid yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {detail.settlements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.customerName} · {s.periodKey} ·{' '}
                  <span className="font-mono">{money(s.amount)}</span>{' '}
                  {s.creditRef ? (
                    <span className="text-xs text-fg-muted">{s.creditRef}</span>
                  ) : null}
                </span>
                <Chip tone={SETTLEMENT_TONE[s.status] ?? 'grey'}>
                  {s.status === 'settled'
                    ? 'Paid'
                    : s.status === 'pending'
                      ? 'Waiting for approval'
                      : s.status === 'rejected'
                        ? 'Refused'
                        : 'Withdrawn'}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="History" className={`${cardClass} space-y-2`}>
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ul className="space-y-1 text-sm">
          {detail.timeline.map((t, i) => (
            <li key={i}>
              {EVENTS[t.action] ?? t.action.replace('pricing.', '').replace(/_/g, ' ')}{' '}
              <span className="text-xs text-fg-muted">
                <When iso={t.at} />
                {t.reason ? ` · ${t.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
