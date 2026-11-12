'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { setCustomerTextsAction, type customerMessagesAction } from '@/server/domains/delivery/message-actions';
import { LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { TEXT_KIND_CHOICES, minutesToClock, type MessageKind } from '@/lib/delivery-messages';

type Loaded = Awaited<ReturnType<typeof customerMessagesAction>>;
type Data = Extract<Loaded, { ok: true }>['data'];

export function CustomerMessagesClient({ firstPromise }: { firstPromise: ReturnType<typeof customerMessagesAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Customer messages"
        intro="Customers are emailed as their delivery moves: on its way, delivered, could not be delivered. You can also text them, to the mobile number on the order, through your own SMS provider. Texts carry the same facts as the email and the tracking link, and never an address or a payment."
      />
      <Message notice={notice} />
      <TextsForm
        key={data.settings.version}
        data={data}
        onSaved={(settings) => {
          setData({ ...data, settings });
          setNotice({ kind: 'ok', text: settings.enabled ? 'Saved. Customers are now texted for the messages ticked.' : 'Saved. Customers are no longer texted; the emails go as before.' });
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
    </div>
  );
}

function TextsForm({ data, onSaved, onError }: { data: Data; onSaved: (settings: Data['settings']) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [kinds, setKinds] = useState<MessageKind[]>(data.settings.kinds);
  const [quietFrom, setQuietFrom] = useState(data.settings.quiet === null ? '' : minutesToClock(data.settings.quiet.from));
  const [quietUntil, setQuietUntil] = useState(data.settings.quiet === null ? '' : minutesToClock(data.settings.quiet.until));
  const [busy, setBusy] = useState(false);
  const savedFrom = data.settings.quiet === null ? '' : minutesToClock(data.settings.quiet.from);
  const savedUntil = data.settings.quiet === null ? '' : minutesToClock(data.settings.quiet.until);
  const toggle = (kind: MessageKind) => setKinds((k) => (k.includes(kind) ? k.filter((x) => x !== kind) : [...k, kind]));
  const save = async () => {
    setBusy(true);
    const r = await attempt(setCustomerTextsAction({ enabled, kinds, quietFrom, quietUntil, expectedVersion: data.settings.version }));
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else onError(r.error);
  };
  return (
    <form
      aria-label="Customer texts"
      className={`${cardClass} space-y-4`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Text customers about their delivery</h3>
      <label htmlFor={`${uid}-on`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg">
        <input id={`${uid}-on`} type="checkbox" className="h-5 w-5 accent-indigo-600" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Also text customers
      </label>
      <fieldset className="space-y-1" disabled={!enabled}>
        <legend className="text-xs font-semibold text-fg">Which messages are also texted</legend>
        {TEXT_KIND_CHOICES.map((c) => (
          <label key={c.kind} htmlFor={`${uid}-${c.kind}`} className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm text-fg">
            <input id={`${uid}-${c.kind}`} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-indigo-600" checked={kinds.includes(c.kind)} onChange={() => toggle(c.kind)} />
            <span>
              {c.label}
              <span className="block text-xs text-fg-muted">{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2" disabled={!enabled}>
        <legend className="text-xs font-semibold text-fg">Quiet hours (optional)</legend>
        <p className="text-xs text-fg-muted">A text that falls between these times waits and goes when they end, so nobody is woken at night. Emails are not held. Leave both empty to text at any hour.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={`${uid}-qf`} className="block text-xs font-semibold text-fg">
            No texts from
            <input id={`${uid}-qf`} type="time" className={`${fieldClass} mt-1`} value={quietFrom} onChange={(e) => setQuietFrom(e.target.value)} />
          </label>
          <label htmlFor={`${uid}-qu`} className="block text-xs font-semibold text-fg">
            Texts resume at
            <input id={`${uid}-qu`} type="time" className={`${fieldClass} mt-1`} value={quietUntil} onChange={(e) => setQuietUntil(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <p role="status" className="text-xs text-fg-muted">
        {data.textsGoThrough === null ? (
          <>
            No SMS provider is connected, so no text can be sent yet. A text is tried again for a little over an hour, so one connected soon still sends it.{' '}
            <Link className="font-semibold underline" href="/admin/settings/sms">
              Connect one in Settings › SMS providers
            </Link>
            .
          </>
        ) : (
          `Texts go through the connection called “${data.textsGoThrough}”.`
        )}{' '}
        Each text costs what your provider charges. A customer whose order has no valid mobile number is simply not texted; the email still goes.
      </p>
      <button type="submit" className={primaryClass} disabled={busy || (enabled === data.settings.enabled && quietFrom === savedFrom && quietUntil === savedUntil && kinds.length === data.settings.kinds.length && kinds.every((k) => data.settings.kinds.includes(k)))}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
