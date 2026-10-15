'use client';

import { useId, useState } from 'react';
import Image from 'next/image';
import { providerOperationLogAction, requestPayoutAction, runProviderOperationAction, saveProviderSettingsAction } from '@/server/domains/payments/activity-actions';
import type { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { ALLOCATION_MODES, TIMEOUT_RESPONSES, VALIDATION_ANSWERS, VERIFICATION_MODES, labelOf, words, type Choice } from '@/lib/payment-options';
import { fieldHint, fieldInputMode, fieldText, operationInput, runButtonLabel, settingsPatch } from '@/lib/mpesa-settings-form';
import { shortReason, when } from '@/lib/payment-activity-format';
import { Chip, Field, Message, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];
type Provider = Setup['providers'][number];
type Daraja = NonNullable<Provider['daraja']>;

const OP_STATUS: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { succeeded: 'green', accepted: 'sky', submitted: 'sky', queued: 'amber', failed: 'red', in_doubt: 'red', timed_out: 'amber' };

interface LoggedRequest {
  id: string;
  operation: string;
  status: string;
  failureReason: string | null;
  at: string | null;
}

/** How an M-Pesa provider confirms payments, who may call us, and which operations it may run. */
export function DarajaPanel({ setup, provider: p, daraja: d, onChanged }: { setup: Setup; provider: Provider; daraja: Daraja; onChanged: (text?: string) => void }) {
  const [log, setLog] = useState<LoggedRequest[]>(setup.recentRequests[p.id] ?? []);
  const refreshLog = async () => {
    const r = await attempt(providerOperationLogAction(p.id));
    if (r.ok) setLog(r.data);
  };

  return (
    <div className="space-y-5 border-t border-line pt-4">
      <h4 className="text-sm font-bold text-fg-strong">M-Pesa settings</h4>
      {!d.hasInitiator ? <p className="text-xs text-amber-700" role="status">The API operator (name, password and Safaricom certificate) is not saved. Without it, payments made straight to a paybill or till can only be confirmed through Pull Transactions, and status checks, reversals, pay-outs, balance and tax remittance cannot run.</p> : null}
      <DarajaSettingsForm providerId={p.id} daraja={d} canEdit={setup.can.editProvider} onChanged={onChanged} />
      {setup.can.runOperations || setup.can.requestPayout ? <DarajaRunOperation providerId={p.id} daraja={d} onRan={refreshLog} /> : null}
      <DarajaOperationLog log={log} />
    </div>
  );
}

const pick = (list: readonly Choice[], id: string): Choice => ({ id, label: labelOf(list, id) ?? id });

function DarajaSettingsForm({ providerId, daraja: d, canEdit, onChanged }: { providerId: string; daraja: Daraja; canEdit: boolean; onChanged: (text?: string) => void }) {
  const uid = useId();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Choice | null>(pick(VERIFICATION_MODES, d.settings.verification.mode));
  const [windowMin, setWindowMin] = useState(String(d.settings.verification.windowMinutes));
  const [poll, setPoll] = useState(d.settings.verification.pollSeconds.join(', '));
  const [cidrs, setCidrs] = useState(d.settings.security.allowedCidrs.join('\n'));
  const [resp, setResp] = useState<Choice | null>(pick(TIMEOUT_RESPONSES, d.settings.c2b.responseType));
  const [validation, setValidation] = useState<Choice | null>(pick(VALIDATION_ANSWERS, d.settings.c2b.validation));
  const [auto, setAuto] = useState<Choice | null>(pick(ALLOCATION_MODES, d.settings.c2b.autoAllocate));
  const [ops, setOps] = useState(Object.fromEntries(d.operations.map((o) => [o.code, { enabled: o.enabled, maxAmount: o.maxAmount ?? '' }])));
  const [dailyLimit, setDailyLimit] = useState(d.settings.dailyPayoutLimit ?? '');

  const saveSettings = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveProviderSettingsAction(providerId, settingsPatch({
      mode: mode?.id ?? 'standard', windowMinutes: windowMin, poll, cidrs, responseType: resp?.id ?? 'Completed', validation: validation?.id ?? 'accept_all',
      autoAllocate: auto?.id ?? 'off', dailyLimit, operations: ops,
    })));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'M-Pesa settings saved.' });
    onChanged();
  };

  return (
    <form onSubmit={(e) => void saveSettings(e)} className="space-y-5" aria-label="M-Pesa settings form">
      <Message notice={notice} />
      <fieldset className="space-y-3">
        <legend className="text-xs font-bold uppercase text-fg-muted">How a payment is confirmed</legend>
        <p className="text-xs text-fg-muted">A callback is never believed on its own. Every payment is checked with Safaricom before it counts; a callback that disagrees with what we asked for is refused.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ChoicePicker label="Check" source="mpesa-verification-modes" choice={mode} onChoice={setMode} clearable={false} required disabled={!canEdit} />
          <Field id={`${uid}-win`} label="Keep asking for (minutes)" hint="After this it is left for a person."><input id={`${uid}-win`} inputMode="numeric" value={windowMin} onChange={(e) => setWindowMin(e.target.value)} className={fieldClass} disabled={!canEdit} /></Field>
          <Field id={`${uid}-poll`} label="Ask again after (seconds)" hint="Comma separated; the last repeats."><input id={`${uid}-poll`} value={poll} onChange={(e) => setPoll(e.target.value)} className={fieldClass} disabled={!canEdit} /></Field>
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-xs font-bold uppercase text-fg-muted">Who may call us</legend>
        <Field id={`${uid}-ip`} label="Only these addresses (one per line)" hint="Safaricom does not publish a list you can rely on, so none is assumed. Get yours from Safaricom support or your logs. Empty = every address (every callback is still checked with Safaricom).">
          <textarea id={`${uid}-ip`} rows={3} value={cidrs} onChange={(e) => setCidrs(e.target.value)} className={`${fieldClass} font-mono text-xs`} placeholder="196.201.214.0/24" disabled={!canEdit} />
        </Field>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-xs font-bold uppercase text-fg-muted">Payments made straight to a paybill or till</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ChoicePicker label="If our validation does not answer" source="mpesa-timeout-responses" choice={resp} onChoice={setResp} clearable={false} required disabled={!canEdit} />
          <ChoicePicker label="Validation answers" source="mpesa-validation-answers" choice={validation} onChoice={setValidation} clearable={false} required disabled={!canEdit} />
          <ChoicePicker label="Once confirmed" source="mpesa-allocation-modes" choice={auto} onChoice={setAuto} clearable={false} required disabled={!canEdit} />
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-xs font-bold uppercase text-fg-muted">What this provider may do</legend>
        <ul className="divide-y divide-line text-sm">
          {d.operations.map((o) => (
            <li key={o.code} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={ops[o.code].enabled} onChange={(e) => setOps((x) => ({ ...x, [o.code]: { ...x[o.code], enabled: e.target.checked } }))} disabled={!canEdit} /> <span>{o.label}</span>{o.moneyOut ? <Chip tone="red">Moves money out</Chip> : null}{o.needsInitiator ? <Chip tone="gray">Needs the API operator</Chip> : null}{o.sandboxOnly ? <Chip tone="gray">Testing only</Chip> : null}</label>
              <label className="flex items-center gap-2 text-xs text-fg-muted">Most per request <input aria-label={`Most per request for ${o.label}`} inputMode="decimal" value={ops[o.code].maxAmount} onChange={(e) => setOps((x) => ({ ...x, [o.code]: { ...x[o.code], maxAmount: e.target.value } }))} className={`${fieldClass} w-28`} disabled={!canEdit} /></label>
            </li>
          ))}
        </ul>
        <Field id={`${uid}-dpl`} label="Most that may be paid out in any 24 hours (KES)" hint="Counts everything requested, approved and sent. Empty = no cap."><input id={`${uid}-dpl`} inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className={fieldClass} disabled={!canEdit} /></Field>
      </fieldset>
      {canEdit ? <button type="submit" className={primaryClass} disabled={busy}>Save M-Pesa settings</button> : null}
    </form>
  );
}

interface RunResult {
  status: string;
  failureReason: string | null;
  qr: string | null;
  detail: string;
}

function DarajaRunOperation({ providerId, daraja: d, onRan }: { providerId: string; daraja: Daraja; onRan: () => Promise<void> }) {
  const uid = useId();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [opChoice, setOpChoice] = useState<Choice | null>(null);
  const [method, setMethod] = useState<Choice | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const opCode = opChoice?.id ?? '';
  const selected = d.operations.find((o) => o.code === opCode);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const valueOf = (fld: { defaultValue?: string }, key: string) => (Object.hasOwn(f, key) ? f[key] : (fld.defaultValue ?? ''));
  const fieldChoice = (fld: { options?: [string, string][]; defaultValue?: string }, key: string): Choice | null => {
    const id = valueOf(fld, key);
    return id === '' ? null : { id, label: fld.options?.find(([v]) => v === id)?.[1] ?? id };
  };

  const runOp = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (selected === undefined) return;
    setBusy(true);
    setNotice(null);
    setResult(null);
    const input = operationInput(selected.fields, f, opCode);
    if (selected.moneyOut) {
      const res = await attempt(requestPayoutAction({ providerId, methodId: method?.id ?? '', operation: opCode as never, input }));
      setBusy(false);
      if (!res.ok) {
        setNotice({ kind: 'error', text: res.error });
        return;
      }
      setNotice({ kind: 'ok', text: res.data.status === 'pending_approval' ? 'Requested. Nothing is sent until someone else approves it (Approvals).' : 'Approved and queued: it is sent within a minute.' });
      await onRan();
      return;
    }
    const res = await attempt(runProviderOperationAction({ providerId, operation: opCode as never, methodId: method?.id, input }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setResult({ status: res.data.status, failureReason: res.data.failureReason, qr: res.data.qrCode, detail: res.data.detail });
    await onRan();
  };

  return (
    <form onSubmit={(e) => void runOp(e)} className={`${cardClass} space-y-3`} aria-label="Run an operation">
      <h5 className="text-sm font-bold text-fg-strong">Run an operation</h5>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Operation" source="daraja-operations" filters={{ provider: providerId }} choice={opChoice} onChoice={(c) => { setOpChoice(c); setResult(null); }} clearable={false} required placeholder="Choose an operation…" />
        <ChoicePicker label="For which paybill or till" source="provider-numbers" filters={{ provider: providerId }} choice={method} onChoice={setMethod} placeholder="The provider's own shortcode" />
      </div>
      {selected !== undefined ? <p className="text-xs text-fg-muted">{selected.description}</p> : null}
      {selected !== undefined && selected.fields.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {selected.fields.map((fld) => {
            const id = `${uid}-${opCode}-${fld.key}`;
            const key = `${opCode}.${fld.key}`;
            if (fld.type === 'select') {
              return (
                <ChoicePicker key={key} label={fld.label} source="daraja-field-options" filters={{ operation: opCode, field: fld.key }} choice={fieldChoice(fld, key)} onChoice={(c) => set(key, c?.id ?? '')} clearable={fld.required !== true} required={fld.required === true} />
              );
            }
            return (
              <Field key={key} id={id} label={fld.label} hint={fieldHint(fld)}>
                <input id={id} type={fld.type === 'date' ? 'date' : 'text'} inputMode={fieldInputMode(fld.type)} value={valueOf(fld, key)} onChange={(e) => set(key, fieldText(fld.key, e.target.value))} className={fieldClass} required={fld.required} maxLength={fld.maxLength} placeholder={fld.placeholder} />
              </Field>
            );
          })}
        </div>
      ) : null}
      {selected?.moneyOut === true ? <p className="text-xs font-semibold text-amber-700" role="note">This moves money out. It is only requested here; someone else must approve it before anything is sent.</p> : null}
      {selected?.async === true ? <p className="text-xs text-fg-muted">Safaricom answers a moment later on our result address; the answer appears below and under Payments → activity.</p> : null}
      <button type="submit" className={buttonClass} disabled={busy || selected === undefined}>{runButtonLabel(busy, selected?.moneyOut === true)}</button>
      {result !== null ? (
        <div role="status" className="space-y-2 rounded-lg border border-line p-3 text-sm">
          <p><Chip tone={OP_STATUS[result.status] ?? 'gray'}>{words(result.status)}</Chip> {result.failureReason !== null && result.failureReason !== '' ? <span className="text-red-700">{result.failureReason}</span> : null}</p>
          {result.qr !== null ? (
            <div>
              <Image unoptimized alt="Dynamic M-Pesa QR code" src={`data:image/png;base64,${result.qr}`} width={200} height={200} className="rounded border border-line bg-white" />
              <a className="mt-1 block text-xs font-semibold text-indigo-600 underline" download="mpesa-qr.png" href={`data:image/png;base64,${result.qr}`}>Download the QR code</a>
            </div>
          ) : null}
          <details><summary className="min-h-10 cursor-pointer py-2 text-xs font-semibold text-indigo-600">What Safaricom answered</summary><pre className="max-h-64 overflow-auto text-xs">{result.detail}</pre></details>
        </div>
      ) : null}
    </form>
  );
}

function DarajaOperationLog({ log }: { log: LoggedRequest[] }) {
  if (log.length === 0) return null;
  return (
    <div>
      <h5 className="text-xs font-bold uppercase text-fg-muted">Recent requests to Safaricom</h5>
      <ul className="mt-1 divide-y divide-line text-xs">
        {log.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>{words(o.operation)} · {when(o.at)}</span>
            <span className="flex items-center gap-2"><Chip tone={OP_STATUS[o.status] ?? 'gray'}>{words(o.status)}</Chip>{o.failureReason !== null && o.failureReason !== '' ? <span className="text-red-700">{shortReason(o.failureReason, 80)}</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
