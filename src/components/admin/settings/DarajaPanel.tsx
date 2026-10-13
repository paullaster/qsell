'use client';

import { useEffect, useId, useState } from 'react';
import { providerOperationLogAction, requestPayoutAction, runProviderOperationAction, saveProviderSettingsAction } from '@/server/domains/payments/activity-actions';
import type { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { Chip, Field, Message, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];
type Provider = Setup['providers'][number];
type Daraja = NonNullable<Provider['daraja']>;

const OP_STATUS: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { succeeded: 'green', accepted: 'sky', submitted: 'sky', queued: 'amber', failed: 'red', in_doubt: 'red', timed_out: 'amber' };

/** How an M-Pesa provider confirms payments, who may call us, and which operations it may run. */
export function DarajaPanel({ setup, provider: p, onChanged }: { setup: Setup; provider: Provider; onChanged: (text?: string) => void }) {
  const uid = useId();
  const d = p.daraja as Daraja;
  const can = setup.can;
  const methods = setup.methods.filter((m) => m.providerId === p.id && m.channelNumber);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(d.settings.verification.mode);
  const [windowMin, setWindowMin] = useState(String(d.settings.verification.windowMinutes));
  const [poll, setPoll] = useState(d.settings.verification.pollSeconds.join(', '));
  const [cidrs, setCidrs] = useState(d.settings.security.allowedCidrs.join('\n'));
  const [resp, setResp] = useState(d.settings.c2b.responseType);
  const [validation, setValidation] = useState(d.settings.c2b.validation);
  const [auto, setAuto] = useState(d.settings.c2b.autoAllocate);
  const [ops, setOps] = useState(Object.fromEntries(d.operations.map((o) => [o.code, { enabled: o.enabled, maxAmount: o.maxAmount ?? '' }])));
  const [dailyLimit, setDailyLimit] = useState(d.settings.dailyPayoutLimit ?? '');
  const [opCode, setOpCode] = useState('c2b_register_urls');
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const [f, setF] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ status: string; failureReason: string | null; qr: string | null; detail: string } | null>(null);
  const [log, setLog] = useState<{ id: string; operation: string; status: string; failureReason: string | null; at: string | null }[]>([]);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const loadLog = async () => {
    const r = await attempt(providerOperationLogAction(p.id));
    if (r.ok) setLog(r.data);
  };
  useEffect(() => {
    void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const pollSeconds = poll.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
    const res = await attempt(saveProviderSettingsAction(p.id, {
      verification: { mode, windowMinutes: Number(windowMin) || 120, pollSeconds },
      security: { allowedCidrs: cidrs.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) },
      c2b: { responseType: resp, validation, autoAllocate: auto },
      dailyPayoutLimit: dailyLimit.trim() || null,
      operations: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { enabled: v.enabled, maxAmount: v.maxAmount.trim() || null }])),
    }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: 'M-Pesa settings saved.' });
    onChanged();
  };

  const selected = d.operations.find((o) => o.code === opCode);
  const runnable = d.operations.filter((o) => o.enabled && !o.internal && (!o.moneyOut || can.requestPayout) && (o.moneyOut || can.runOperations));
  const runOp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    setResult(null);
    const input: Record<string, unknown> = {};
    for (const fld of selected.fields) {
      const v = (f[`${opCode}.${fld.key}`] ?? fld.defaultValue ?? '').trim();
      if (v) input[fld.key] = v;
    }
    if (selected.moneyOut) {
      const res = await attempt(requestPayoutAction({ providerId: p.id, methodId, operation: opCode as never, input }));
      setBusy(false);
      if (!res.ok) return setNotice({ kind: 'error', text: res.error });
      setNotice({ kind: 'ok', text: res.data.status === 'pending_approval' ? 'Requested. Nothing is sent until someone else approves it (Approvals).' : 'Approved and queued: it is sent within a minute.' });
      void loadLog();
      return;
    }
    const res = await attempt(runProviderOperationAction({ providerId: p.id, operation: opCode as never, methodId: methodId || undefined, input }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setResult({ status: res.data.status, failureReason: res.data.failureReason, qr: res.data.qrCode, detail: res.data.detail });
    void loadLog();
  };

  return (
    <div className="space-y-5 border-t border-line pt-4">
      <h4 className="text-sm font-bold text-fg-strong">M-Pesa settings</h4>
      <Message notice={notice} />
      {!d.hasInitiator ? <p className="text-xs text-amber-700" role="status">The API operator (name, password and Safaricom certificate) is not saved. Without it, payments made straight to a paybill or till can only be confirmed through Pull Transactions, and status checks, reversals, pay-outs, balance and tax remittance cannot run.</p> : null}

      <form onSubmit={(e) => void saveSettings(e)} className="space-y-5" aria-label="M-Pesa settings form">
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase text-fg-muted">How a payment is confirmed</legend>
          <p className="text-xs text-fg-muted">A callback is never believed on its own. Every payment is checked with Safaricom before it counts; a callback that disagrees with what we asked for is refused.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id={`${uid}-mode`} label="Check"><select id={`${uid}-mode`} value={mode} onChange={(e) => setMode(e.target.value as 'standard')} className={fieldClass} disabled={!can.editProvider}><option value="standard">Standard: ask Safaricom about the request</option><option value="strict">Strict: also check the transaction by its receipt</option></select></Field>
            <Field id={`${uid}-win`} label="Keep asking for (minutes)" hint="After this it is left for a person."><input id={`${uid}-win`} inputMode="numeric" value={windowMin} onChange={(e) => setWindowMin(e.target.value)} className={fieldClass} disabled={!can.editProvider} /></Field>
            <Field id={`${uid}-poll`} label="Ask again after (seconds)" hint="Comma separated; the last repeats."><input id={`${uid}-poll`} value={poll} onChange={(e) => setPoll(e.target.value)} className={fieldClass} disabled={!can.editProvider} /></Field>
          </div>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase text-fg-muted">Who may call us</legend>
          <Field id={`${uid}-ip`} label="Only these addresses (one per line)" hint="Safaricom does not publish a list you can rely on, so none is assumed. Get yours from Safaricom support or your logs. Empty = every address (every callback is still checked with Safaricom).">
            <textarea id={`${uid}-ip`} rows={3} value={cidrs} onChange={(e) => setCidrs(e.target.value)} className={`${fieldClass} font-mono text-xs`} placeholder="196.201.214.0/24" disabled={!can.editProvider} />
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase text-fg-muted">Payments made straight to a paybill or till</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id={`${uid}-rt`} label="If our validation does not answer"><select id={`${uid}-rt`} value={resp} onChange={(e) => setResp(e.target.value as 'Completed')} className={fieldClass} disabled={!can.editProvider}><option value="Completed">Let the payment complete</option><option value="Cancelled">Cancel the payment</option></select></Field>
            <Field id={`${uid}-val`} label="Validation answers"><select id={`${uid}-val`} value={validation} onChange={(e) => setValidation(e.target.value as 'accept_all')} className={fieldClass} disabled={!can.editProvider}><option value="accept_all">Accept every payment</option><option value="known_reference">Accept only a known account number</option><option value="reject_all">Reject every payment</option></select></Field>
            <Field id={`${uid}-auto`} label="Once confirmed"><select id={`${uid}-auto`} value={auto} onChange={(e) => setAuto(e.target.value as 'off')} className={fieldClass} disabled={!can.editProvider}><option value="off">A person places it</option><option value="by_customer_number">Put it on the customer whose number was given</option></select></Field>
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase text-fg-muted">What this provider may do</legend>
          <ul className="divide-y divide-line text-sm">
            {d.operations.map((o) => (
              <li key={o.code} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={ops[o.code]?.enabled ?? false} onChange={(e) => setOps((x) => ({ ...x, [o.code]: { ...(x[o.code] ?? { maxAmount: '' }), enabled: e.target.checked } }))} disabled={!can.editProvider} /> <span>{o.label}</span>{o.moneyOut ? <Chip tone="red">Moves money out</Chip> : null}{o.needsInitiator ? <Chip tone="gray">Needs the API operator</Chip> : null}{o.sandboxOnly ? <Chip tone="gray">Testing only</Chip> : null}</label>
                <label className="flex items-center gap-2 text-xs text-fg-muted">Most per request <input aria-label={`Most per request for ${o.label}`} inputMode="decimal" value={ops[o.code]?.maxAmount ?? ''} onChange={(e) => setOps((x) => ({ ...x, [o.code]: { ...(x[o.code] ?? { enabled: false }), maxAmount: e.target.value } }))} className={`${fieldClass} w-28`} disabled={!can.editProvider} /></label>
              </li>
            ))}
          </ul>
          <Field id={`${uid}-dpl`} label="Most that may be paid out in any 24 hours (KES)" hint="Counts everything requested, approved and sent. Empty = no cap."><input id={`${uid}-dpl`} inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className={fieldClass} disabled={!can.editProvider} /></Field>
        </fieldset>
        {can.editProvider ? <button type="submit" className={primaryClass} disabled={busy}>Save M-Pesa settings</button> : null}
      </form>

      {runnable.length > 0 ? (
        <form onSubmit={(e) => void runOp(e)} className={`${cardClass} space-y-3`} aria-label="Run an operation">
          <h5 className="text-sm font-bold text-fg-strong">Run an operation</h5>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-op`} label="Operation"><select id={`${uid}-op`} value={opCode} onChange={(e) => { setOpCode(e.target.value); setResult(null); }} className={fieldClass}>{runnable.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select></Field>
            <Field id={`${uid}-mt`} label="For which paybill or till"><select id={`${uid}-mt`} value={methodId} onChange={(e) => setMethodId(e.target.value)} className={fieldClass}><option value="">The provider's own shortcode</option>{methods.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.channelKind} {m.channelNumber})</option>)}</select></Field>
          </div>
          {selected ? <p className="text-xs text-fg-muted">{selected.description}</p> : null}
          {selected && selected.fields.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {selected.fields.map((fld) => {
                const id = `${uid}-${opCode}-${fld.key}`;
                const key = `${opCode}.${fld.key}`;
                return (
                  <Field key={key} id={id} label={fld.label} hint={fld.hint ?? (fld.patternHint ? `Use ${fld.patternHint}.` : undefined)}>
                    {fld.type === 'select' ? (
                      <select id={id} value={f[key] ?? fld.defaultValue ?? ''} onChange={(e) => set(key, e.target.value)} className={fieldClass} required={fld.required}>
                        {(fld.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input id={id} type={fld.type === 'date' ? 'date' : 'text'} inputMode={fld.type === 'number' ? 'decimal' : fld.type === 'phone' ? 'tel' : undefined} value={f[key] ?? fld.defaultValue ?? ''} onChange={(e) => set(key, fld.key === 'transactionId' ? e.target.value.toUpperCase() : e.target.value)} className={fieldClass} required={fld.required} maxLength={fld.maxLength} placeholder={fld.placeholder} />
                    )}
                  </Field>
                );
              })}
            </div>
          ) : null}
          {selected?.moneyOut ? <p className="text-xs font-semibold text-amber-700" role="note">This moves money out. It is only requested here; someone else must approve it before anything is sent.</p> : null}
          {selected?.async ? <p className="text-xs text-fg-muted">Safaricom answers a moment later on our result address; the answer appears below and under Payments → activity.</p> : null}
          <button type="submit" className={buttonClass} disabled={busy}>{busy ? 'Working…' : selected?.moneyOut ? 'Request approval' : 'Run'}</button>
          {result ? (
            <div role="status" className="space-y-2 rounded-lg border border-line p-3 text-sm">
              <p><Chip tone={OP_STATUS[result.status] ?? 'gray'}>{result.status.replace('_', ' ')}</Chip> {result.failureReason ? <span className="text-red-700">{result.failureReason}</span> : null}</p>
              {result.qr ? <div><img alt="Dynamic M-Pesa QR code" src={`data:image/png;base64,${result.qr}`} width={200} height={200} className="rounded border border-line bg-white" /><a className="mt-1 block text-xs font-semibold text-indigo-600 underline" download="mpesa-qr.png" href={`data:image/png;base64,${result.qr}`}>Download the QR code</a></div> : null}
              <details><summary className="min-h-10 cursor-pointer py-2 text-xs font-semibold text-indigo-600">What Safaricom answered</summary><pre className="max-h-64 overflow-auto text-xs">{result.detail}</pre></details>
            </div>
          ) : null}
        </form>
      ) : null}

      {log.length > 0 ? (
        <div>
          <h5 className="text-xs font-bold uppercase text-fg-muted">Recent requests to Safaricom</h5>
          <ul className="mt-1 divide-y divide-line text-xs">
            {log.map((o) => <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span>{o.operation.replace(/_/g, ' ')} · {o.at ? new Date(o.at).toLocaleString() : ''}</span><span className="flex items-center gap-2"><Chip tone={OP_STATUS[o.status] ?? 'gray'}>{o.status.replace('_', ' ')}</Chip>{o.failureReason ? <span className="text-red-700">{o.failureReason.slice(0, 80)}</span> : null}</span></li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
