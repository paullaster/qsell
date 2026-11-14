'use client';

import { use, useId, useState } from 'react';
import { createCourierAction, couriersScreenAction, renewCourierSecretAction, setCourierActiveAction, testCourierParcelAction, updateCourierAction } from '@/server/domains/delivery/courier-actions';
import type { CourierAccountView, TestParcelResult } from '@/server/domains/delivery/courier-accounts';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import type { Choice } from '@/lib/payment-options';

type Loaded = Awaited<ReturnType<typeof couriersScreenAction>>;

export function CouriersClient({ firstPromise }: { firstPromise: ReturnType<typeof couriersScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

/** A secret shown once, with the address the courier is to send its news to. It is not kept on the screen after it is closed. */
type Reveal = { name: string; path: string; secret: string } | null;

function Body({ initial }: { initial: CourierAccountView[] }) {
  const [list, setList] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [reveal, setReveal] = useState<Reveal>(null);
  // The add form starts again, empty, after a courier is added, so a key typed into it is not left on the screen.
  const [fresh, setFresh] = useState(0);
  const reload = async (text: string) => {
    const r = await attempt(couriersScreenAction());
    if (r.ok) {
      setList(r.data);
      setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const fail = (text: string) => setNotice({ kind: 'error', text });
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Couriers" intro="The couriers you send parcels with. A courier connected to its own system is told about each parcel, asked where it is, and listened to; one typed in by hand has its news recorded by your staff. A courier that cannot be reached never stops a delivery from going out." />
      <Message notice={notice} />
      {reveal === null ? null : (
        <section role="status" aria-label="Secret for the courier" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Give {reveal.name} this now. It will not be shown again.</p>
          <p>
            Address for its news, on this shop&apos;s web address: <code className="break-all font-mono">{reveal.path}</code>
          </p>
          <p>
            Secret to sign each message with (HMAC-SHA256, in the <code className="font-mono">X-Signature</code> header): <code className="break-all font-mono">{reveal.secret}</code>
          </p>
          <button type="button" className={buttonClass} onClick={() => setReveal(null)}>
            I have copied it
          </button>
        </section>
      )}
      <CourierForm key={`new-${String(fresh)}`} onSaved={(t, r) => { setReveal(r); setFresh((n) => n + 1); void reload(t); }} onError={fail} />
      <section aria-label="Couriers" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Your couriers</h3>
        {list.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No courier yet. Add one above. A courier with no connection is still fine: type its tracking number in when you send a parcel.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Courier list">
          {list.map((a) => (
            <CourierRow key={`${a.id}-${String(a.version)}`} account={a} onSaved={(t, r) => { if (r !== null) setReveal(r); void reload(t); }} onError={fail} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function CourierForm({ account, onSaved, onError }: { account?: CourierAccountView; onSaved: (text: string, reveal: Reveal) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<Choice | null>(account === undefined ? { id: 'manual', label: 'By hand (typed in)' } : { id: account.adapter, label: account.adapterWords });
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [authHeader, setAuthHeader] = useState(account?.authHeader ?? 'Authorization');
  const [bookPath, setBookPath] = useState(account?.bookPath ?? '/shipments');
  const [trackPath, setTrackPath] = useState(account?.trackPath ?? '/shipments/{tracking}');
  const [cancelPath, setCancelPath] = useState(account?.cancelPath ?? '/shipments/{tracking}');
  const [cancelMethod, setCancelMethod] = useState<'DELETE' | 'POST'>(account?.cancelMethod ?? 'DELETE');
  const [mapping, setMapping] = useState(account?.mapping ?? '');
  const [busy, setBusy] = useState(false);
  const connected = kind?.id === 'http_json';
  const saveWords = account === undefined ? 'Add the courier' : 'Save the courier';
  const save = async () => {
    setBusy(true);
    const body = { name, ...(connected ? { baseUrl, apiKey, authHeader, bookPath, trackPath, cancelPath, cancelMethod, mapping } : {}) };
    if (account !== undefined) {
      const r = await attempt(updateCourierAction({ ...body, id: account.id, expectedVersion: account.version }));
      setBusy(false);
      if (r.ok) onSaved('The courier is saved.', null);
      else onError(r.error);
      return;
    }
    const r = await attempt(createCourierAction({ ...body, adapter: kind?.id ?? 'manual' }));
    setBusy(false);
    if (!r.ok) onError(r.error);
    else onSaved('The courier is added.', r.data.webhookSecret === null ? null : { name: r.data.account.name, path: r.data.account.webhookPath, secret: r.data.webhookSecret });
  };
  return (
    <form
      aria-label={account === undefined ? 'Add a courier' : `Change ${account.name}`}
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {account === undefined ? <h3 className="text-sm font-bold text-fg-strong">Add a courier</h3> : null}
      <Field id={`${uid}-n`} label="Name">
        <input id={`${uid}-n`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" required />
      </Field>
      {account === undefined ? <ChoicePicker label="How it is connected" source="courier-adapters" choice={kind} onChoice={setKind} placeholder="Choose" /> : <p className="text-sm text-fg-muted">Connection: {account.adapterWords}</p>}
      {connected ? (
        <>
          <Field id={`${uid}-u`} label="The courier's web address" hint="Starts with https://. Only public addresses are allowed.">
            <input id={`${uid}-u`} className={fieldClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} maxLength={300} autoComplete="off" placeholder="https://api.example-courier.co.ke" required />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-k`} label={account === undefined ? 'Key the courier gave you' : 'New key (leave empty to keep the one saved)'} hint="Kept sealed. It is never shown again.">
              <input id={`${uid}-k`} type="password" className={fieldClass} value={apiKey} onChange={(e) => setApiKey(e.target.value)} maxLength={500} autoComplete="new-password" required={account === undefined} />
            </Field>
            <Field id={`${uid}-h`} label="Header that carries the key">
              <input id={`${uid}-h`} className={fieldClass} value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} maxLength={40} autoComplete="off" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id={`${uid}-b`} label="Path to book a parcel">
              <input id={`${uid}-b`} className={`${fieldClass} font-mono`} value={bookPath} onChange={(e) => setBookPath(e.target.value)} maxLength={120} autoComplete="off" />
            </Field>
            <Field id={`${uid}-t`} label="Path to ask about one" hint="{tracking} stands for the tracking number.">
              <input id={`${uid}-t`} className={`${fieldClass} font-mono`} value={trackPath} onChange={(e) => setTrackPath(e.target.value)} maxLength={120} autoComplete="off" />
            </Field>
            <Field id={`${uid}-c`} label="Path to cancel one">
              <input id={`${uid}-c`} className={`${fieldClass} font-mono`} value={cancelPath} onChange={(e) => setCancelPath(e.target.value)} maxLength={120} autoComplete="off" />
            </Field>
          </div>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="text-xs font-semibold text-fg">Cancel with</legend>
            {(['DELETE', 'POST'] as const).map((m) => (
              <label key={m} className="flex min-h-10 items-center gap-2 text-sm">
                <input type="radio" name={`${uid}-cm`} className="h-4 w-4" checked={cancelMethod === m} onChange={() => setCancelMethod(m)} />
                {m}
              </label>
            ))}
          </fieldset>
          <Field id={`${uid}-m`} label="Where to find things in the courier's answers (JSON, optional)" hint='Leave empty for the usual names (tracking_number, status, label_url…). For example {"tracking":"data.waybill","states":{"delivered":["DONE"]}}.'>
            <textarea id={`${uid}-m`} className={`${fieldClass} font-mono`} rows={6} value={mapping} onChange={(e) => setMapping(e.target.value)} maxLength={4000} spellCheck={false} />
          </Field>
        </>
      ) : null}
      <button type="submit" className={primaryClass} disabled={busy}>
        {busy ? 'Saving…' : saveWords}
      </button>
    </form>
  );
}

function CourierRow({ account, onSaved, onError }: { account: CourierAccountView; onSaved: (text: string, reveal: Reveal) => void; onError: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<TestParcelResult | null>(null);
  const toggle = async () => {
    setBusy(true);
    const r = await attempt(setCourierActiveAction({ id: account.id, isActive: !account.isActive, expectedVersion: account.version }));
    setBusy(false);
    if (r.ok) onSaved(account.isActive ? 'The courier is stopped. It is no longer offered for new parcels; parcels already with it are still followed.' : 'The courier is offered again.', null);
    else onError(r.error);
  };
  const test = async () => {
    setBusy(true);
    const r = await attempt(testCourierParcelAction({ id: account.id }));
    setBusy(false);
    if (r.ok) setTested(r.data);
    else onError(r.error);
  };
  const renew = async () => {
    setBusy(true);
    const r = await attempt(renewCourierSecretAction({ id: account.id }));
    setBusy(false);
    if (r.ok) onSaved('A new secret is made. The old one no longer works.', { name: account.name, path: account.webhookPath, secret: r.data.webhookSecret });
    else onError(r.error);
  };
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-bold text-fg-strong">{account.name}</h4>
        <Chip tone={account.isActive ? 'green' : 'gray'}>{account.isActive ? 'In use' : 'Stopped'}</Chip>
        <Chip tone={account.adapter === 'http_json' ? 'sky' : 'gray'}>{account.adapterWords}</Chip>
        {account.adapter === 'http_json' && !account.hasKey ? <Chip tone="red">No key</Chip> : null}
      </div>
      {account.baseUrl === null ? null : (
        <p className="text-sm text-fg-muted">
          <span className="break-all">{account.baseUrl}</span>
          {' · news arrives at '}
          <code className="break-all font-mono">{account.webhookPath}</code>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? 'Close' : `Change ${account.name}`}
        </button>
        {account.isActive ? (
          <InlineConfirm label={`Stop using ${account.name}`} action="Stop using" confirm="Yes, stop it" busy={busy} onConfirm={() => void toggle()} />
        ) : (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void toggle()}>
            Use it again
          </button>
        )}
        {account.adapter === 'http_json' ? <InlineConfirm label={`Make a new secret for ${account.name}`} action="New secret" confirm="Yes, make a new one" busy={busy} onConfirm={() => void renew()} /> : null}
      </div>
      {account.adapter === 'http_json' && account.hasKey ? (
        <InlineConfirm label={`Send a test parcel to ${account.name}`} action="Send a test parcel" confirm="Yes, send it (the courier may see it)" busy={busy} onConfirm={() => void test()} />
      ) : null}
      {tested === null ? <LastTest name={account.name} last={account.lastTest} /> : <TestResult name={account.name} result={tested} />}
      {editing ? <CourierForm account={account} onSaved={onSaved} onError={onError} /> : null}
    </li>
  );
}

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

/** What the last test parcel did, kept with the courier so it is still there tomorrow; nothing is shown before a first test. */
function LastTest({ name, last }: { name: string; last: CourierAccountView['lastTest'] }) {
  if (last === null) return null;
  const ok = last.booked && last.cancelled;
  const outcome = ok ? 'Booked and cancelled again' : 'Not booked';
  const words = last.booked && !last.cancelled ? 'Booked, but not cancelled' : outcome;
  return (
    <p aria-label={`Last test parcel for ${name}`} className="text-xs text-fg-muted">
      <span className={`font-semibold ${ok ? 'text-fg' : 'text-red-700 dark:text-red-300'}`}>Last test, {when(last.at)}: {words}.</span> {last.message}
    </p>
  );
}

/** What a test parcel did: shown in place so the person sees it, and stays until the page is left. */
function TestResult({ name, result }: { name: string; result: TestParcelResult }) {
  return (
    <div role="status" aria-label={`Test parcel for ${name}`} className="space-y-1 rounded-lg border border-line bg-surface p-3 text-sm">
      <p className={`font-semibold ${result.booked ? 'text-fg-strong' : 'text-red-700 dark:text-red-300'}`}>{result.booked ? 'The test parcel was booked.' : 'The test parcel was not booked.'}</p>
      <p className="text-fg-muted">{result.message}</p>
      {result.trackingUrl === null ? null : <p className="break-all text-xs text-fg-muted">Tracking page: {result.trackingUrl}</p>}
      {result.labelUrl === null ? null : <p className="break-all text-xs text-fg-muted">Label: {result.labelUrl}</p>}
      {result.booked ? <p className="text-fg-muted">{result.cancelled ? 'It was cancelled again straight after.' : (result.cancelMessage ?? '')}</p> : null}
    </div>
  );
}
