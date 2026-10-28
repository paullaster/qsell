'use client';

import { use, useId, useState } from 'react';
import { saveOrderTargetsAction, type orderTargetsAction, type TargetForm } from '@/server/domains/orders/sla-actions';
import { durationWords } from '@/lib/order-sla';
import { Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Loaded = Extract<Awaited<ReturnType<typeof orderTargetsAction>>, { ok: true }>['data'];

export function OrderTargetsClient({ initialPromise }: { initialPromise: ReturnType<typeof orderTargetsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <View initial={res.data} /> : <LoadFailed error={res.error} />;
}

/** Whole minutes as typed; anything else stays as typed so the server can say what is wrong. */
const minutesOf = (text: string): number => (/^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

function View({ initial }: { initial: Loaded }) {
  const uid = useId();
  const [rows, setRows] = useState(() => initial.targets.map((t) => ({ ...t, target: String(t.targetMinutes), escalate: String(t.escalateAfterMinutes) })));
  const [raise, setRaise] = useState(initial.raiseEmails);
  const [escalate, setEscalate] = useState(initial.escalateEmails);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const change = (stage: string, patch: Partial<(typeof rows)[number]>) => setRows((all) => all.map((r) => (r.stage === stage ? { ...r, ...patch } : r)));

  const save = () => {
    setBusy(true);
    setNotice(null);
    const targets: TargetForm[] = rows.map((r) => ({ stage: r.stage, label: r.label, enabled: r.enabled, targetMinutes: minutesOf(r.target), escalateAfterMinutes: minutesOf(r.escalate) }));
    void attempt(saveOrderTargetsAction({ targets, raiseEmails: raise, escalateEmails: escalate })).then((r) => {
      setBusy(false);
      setNotice(r.ok ? { kind: 'ok', text: 'Saved. The new targets apply from the next check, within five minutes.' } : { kind: 'error', text: r.error });
    });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Order targets" intro="How long an order may wait in each stage before it counts as late. A late order is listed under Order flow and mailed to the addresses below; if it is still there after the escalation time, a second mail goes out." />
      <Message notice={notice} />
      <form
        className="space-y-4"
        aria-label="Order targets"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <ul className="space-y-3">
          {rows.map((r) => {
            const targetMinutes = minutesOf(r.target);
            const escalateMinutes = minutesOf(r.escalate);
            return (
              <li key={r.stage} className={`${cardClass} space-y-3`}>
                <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-fg-strong">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => change(r.stage, { enabled: e.target.checked })} className="h-5 w-5" />
                  Watch “{r.label}”
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={`${uid}-${r.stage}-t`} label="Late after (minutes)" hint={Number.isNaN(targetMinutes) ? 'Whole minutes, 5 to 129600 (90 days).' : durationWords(targetMinutes)}>
                    <input id={`${uid}-${r.stage}-t`} inputMode="numeric" value={r.target} onChange={(e) => change(r.stage, { target: e.target.value })} className={fieldClass} autoComplete="off" disabled={!r.enabled} />
                  </Field>
                  <Field id={`${uid}-${r.stage}-e`} label="Then escalate after (minutes)" hint={Number.isNaN(escalateMinutes) ? 'Whole minutes, 5 to 43200 (30 days).' : durationWords(escalateMinutes)}>
                    <input id={`${uid}-${r.stage}-e`} inputMode="numeric" value={r.escalate} onChange={(e) => change(r.stage, { escalate: e.target.value })} className={fieldClass} autoComplete="off" disabled={!r.enabled} />
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>
        <div className={`${cardClass} space-y-3`}>
          <h2 className="text-base font-semibold text-fg-strong">Who is told</h2>
          <Field id={`${uid}-raise`} label="When an order is late" hint="One address per line, up to 10. Leave empty to use the company email.">
            <textarea id={`${uid}-raise`} rows={3} value={raise} onChange={(e) => setRaise(e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-esc`} label="When it is still late after the escalation time" hint="Leave empty to use the list above.">
            <textarea id={`${uid}-esc`} rows={3} value={escalate} onChange={(e) => setEscalate(e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
        </div>
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Saving…' : 'Save targets'}
        </button>
      </form>
    </div>
  );
}
