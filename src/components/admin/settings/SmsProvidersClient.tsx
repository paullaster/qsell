'use client';

import { use, useId, useState } from 'react';
import { createSmsAccountAction, makeSmsAccountDefaultAction, sendTestSmsAction, setSmsAccountActiveAction, smsScreenAction, updateSmsAccountAction } from '@/server/domains/sms/actions';
import type { SmsAccountView } from '@/server/domains/sms/accounts';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import type { Choice } from '@/lib/payment-options';
import { SMS_PROVIDERS, isSmsProviderId, type SmsProviderId } from '@/lib/sms-providers';

type Loaded = Awaited<ReturnType<typeof smsScreenAction>>;

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

function testWords(test: SmsAccountView['lastTest']): string {
  if (test === null) return 'Not tested yet.';
  if (test.ok) return `Test message accepted by the provider on ${when(test.at)}.`;
  return `The last test, on ${when(test.at)}, did not go: ${test.error ?? 'no reason was given'}`;
}

function stoppedWords(account: SmsAccountView): string {
  if (!account.isActive) return 'The connection is in use again.';
  return account.isDefault ? 'The connection is stopped. It was the default, so choose another before sending.' : 'The connection is stopped.';
}

export function SmsProvidersClient({ initialPromise }: { initialPromise: ReturnType<typeof smsScreenAction> }) {
  const res: Loaded = use(initialPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: SmsAccountView[] }) {
  const [list, setList] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  // The add form starts again, empty, after a connection is added, so a key typed into it is not left on the screen.
  const [fresh, setFresh] = useState(0);
  const reload = async (text: string) => {
    const r = await attempt(smsScreenAction());
    if (r.ok) {
      setList(r.data);
      setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const fail = (text: string) => setNotice({ kind: 'error', text });
  const hasDefault = list.some((a) => a.isDefault);
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="SMS providers"
        intro="Connect the SMS provider this business sends text messages with. Every business has its own, so the keys are yours: they are kept sealed, never shown again, and used only when a message is sent. The connection marked as the default is the one messages go through."
      />
      <Message notice={notice} />
      {list.length > 0 && !hasDefault ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          No connection is the default, so no text message can be sent. Choose one below.
        </p>
      ) : null}
      <AccountForm
        key={`new-${String(fresh)}`}
        onSaved={(t) => {
          setFresh((n) => n + 1);
          void reload(t);
        }}
        onError={fail}
      />
      <section aria-label="SMS connections" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Your connections</h3>
        {list.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No SMS provider is connected yet. Add one above. Nothing is sent until you do.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="SMS connection list">
          {list.map((a) => (
            <AccountRow key={`${a.id}-${String(a.version)}`} account={a} onSaved={(t) => void reload(t)} onError={fail} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The form for one connection, drawn from the provider's own list of fields so a new provider needs no new screen. */
function AccountForm({ account, onSaved, onError }: { account?: SmsAccountView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<Choice | null>(account === undefined ? null : { id: account.adapter, label: account.adapterWords });
  const [values, setValues] = useState<Record<string, string>>(account === undefined ? {} : { ...account.values });
  const [busy, setBusy] = useState(false);
  const saveWords = account === undefined ? 'Add the connection' : 'Save the connection';
  const provider: SmsProviderId | null = kind !== null && isSmsProviderId(kind.id) ? kind.id : null;
  const def = provider === null ? null : SMS_PROVIDERS[provider];
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    const body = { name, ...values };
    if (account !== undefined) {
      const r = await attempt(updateSmsAccountAction({ ...body, id: account.id, expectedVersion: account.version }));
      setBusy(false);
      if (r.ok) onSaved('The connection is saved. Send a test message to check it.');
      else onError(r.error);
      return;
    }
    const r = await attempt(createSmsAccountAction({ ...body, adapter: provider ?? '' }));
    setBusy(false);
    if (r.ok) onSaved(r.data.isDefault ? 'The connection is added and is now the one messages go through. Send a test message to check it.' : 'The connection is added. Send a test message to check it.');
    else onError(r.error);
  };
  return (
    <form
      aria-label={account === undefined ? 'Add an SMS provider' : `Change ${account.name}`}
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {account === undefined ? <h3 className="text-sm font-bold text-fg-strong">Add an SMS provider</h3> : null}
      {account === undefined ? (
        <ChoicePicker label="Provider" source="sms-providers" choice={kind} onChoice={setKind} placeholder="Choose your SMS provider" />
      ) : (
        <p className="text-sm text-fg-muted">Provider: {account.adapterWords}</p>
      )}
      {def === null ? null : <p className="text-xs text-fg-muted">{def.summary}</p>}
      <Field id={`${uid}-n`} label="Name" hint="Only for you, to tell connections apart. For example “Main shop SMS”.">
        <input id={`${uid}-n`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" required />
      </Field>
      {def?.fields.map((f) => {
        const kept = account?.secretsKept.includes(f.key) === true;
        const label = f.secret && account !== undefined ? `${f.label} (leave empty to keep the one saved)` : f.label;
        return (
          <Field key={f.key} id={`${uid}-${f.key}`} label={label} hint={f.hint}>
            <input
              id={`${uid}-${f.key}`}
              type={f.secret ? 'password' : 'text'}
              className={f.secret ? `${fieldClass} font-mono` : fieldClass}
              value={values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
              maxLength={f.maxLength}
              autoComplete={f.secret ? 'new-password' : 'off'}
              spellCheck={false}
              placeholder={f.secret && kept ? '•••••••• saved' : f.placeholder}
              required={f.required && !(f.secret && account !== undefined)}
            />
          </Field>
        );
      })}
      <button type="submit" className={primaryClass} disabled={busy || (account === undefined && provider === null)}>
        {busy ? 'Saving…' : saveWords}
      </button>
    </form>
  );
}

function AccountRow({ account, onSaved, onError }: { account: SmsAccountView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const toggle = async () => {
    setBusy(true);
    const r = await attempt(setSmsAccountActiveAction({ id: account.id, isActive: !account.isActive, expectedVersion: account.version }));
    setBusy(false);
    if (r.ok) onSaved(stoppedWords(account));
    else onError(r.error);
  };
  const makeDefault = async () => {
    setBusy(true);
    const r = await attempt(makeSmsAccountDefaultAction({ id: account.id, expectedVersion: account.version }));
    setBusy(false);
    if (r.ok) onSaved('Messages now go through this connection.');
    else onError(r.error);
  };
  const test = async () => {
    setBusy(true);
    const r = await attempt(sendTestSmsAction({ id: account.id, to }));
    setBusy(false);
    if (!r.ok) onError(r.error);
    else if (r.data.lastTest?.ok === true) onSaved('The test message was accepted by the provider. Check the phone.');
    else onError(r.data.lastTest?.error ?? 'The test message could not be sent.');
  };
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-bold text-fg-strong">{account.name}</h4>
        {account.isDefault ? <Chip tone="green">Default: messages go through this</Chip> : null}
        <Chip tone={account.isActive ? 'sky' : 'gray'}>{account.isActive ? 'In use' : 'Stopped'}</Chip>
        <Chip tone="gray">{account.adapterWords}</Chip>
      </div>
      <p className="text-sm text-fg-muted">{testWords(account.lastTest)}</p>
      <div className="flex flex-wrap items-end gap-2">
        {account.isActive ? (
          <>
            <div className="min-w-48 flex-1">
              <Field id={`${uid}-to`} label="Send a test message to" hint="A mobile number, for example 0712 345 678. The words are fixed, and the number is not kept.">
                <input id={`${uid}-to`} type="tel" inputMode="tel" className={fieldClass} value={to} onChange={(e) => setTo(e.target.value)} maxLength={20} autoComplete="off" />
              </Field>
            </div>
            <button type="button" className={buttonClass} disabled={busy || to.trim() === ''} onClick={() => void test()}>
              {busy ? 'Sending…' : 'Send the test'}
            </button>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? 'Close' : `Change ${account.name}`}
        </button>
        {account.isActive && !account.isDefault ? (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void makeDefault()}>
            Make this the default
          </button>
        ) : null}
        {account.isActive ? (
          <InlineConfirm label={`Stop using ${account.name}`} action="Stop using" confirm="Yes, stop it" busy={busy} onConfirm={() => void toggle()} />
        ) : (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void toggle()}>
            Use it again
          </button>
        )}
      </div>
      {editing ? <AccountForm account={account} onSaved={(t) => { setEditing(false); onSaved(t); }} onError={onError} /> : null}
    </li>
  );
}
