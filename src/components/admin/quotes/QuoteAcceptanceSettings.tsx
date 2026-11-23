'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Bell, CheckCircle2, Mail, MessageSquareText } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { buttonClass, primaryClass } from '@/components/ui/screen-kit';
import { getQuoteAcceptanceAction, updateQuoteAcceptanceAction } from '@/server/domains/quotes/actions';
import { ACCEPTANCE_MODES, MODE_WORDS, type AcceptanceMode, type AcceptanceSettings } from '@/lib/quote-acceptance';

type Load = { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; smsConnected: boolean; pushAvailable: boolean };

/**
 * The company's choice for what happens when a customer accepts a quote from their link, and how the staff concerned are told. The mode
 * is four plain cards; the ways of telling staff are three switches that say, in place, when one cannot work yet.
 */
export function QuoteAcceptanceSettings({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [settings, setSettings] = useState<AcceptanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let current = true;
    void getQuoteAcceptanceAction().then((r) => {
      if (!current) return;
      if (!r.ok) setLoad({ phase: 'error', error: r.error });
      else {
        setSettings(r.data.settings);
        setLoad({ phase: 'ready', smsConnected: r.data.smsConnected, pushAvailable: r.data.pushAvailable });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const save = async () => {
    if (settings === null || busy) return;
    setBusy(true);
    setMessage(null);
    const r = await updateQuoteAcceptanceAction(settings);
    setBusy(false);
    setMessage(r.ok ? { kind: 'ok', text: 'Saved. It applies to the next quote a customer accepts.' } : { kind: 'error', text: r.error });
  };

  const set = <K extends keyof AcceptanceSettings>(key: K, value: AcceptanceSettings[K]) => {
    setSettings((s) => (s === null ? s : { ...s, [key]: value }));
    setMessage(null);
  };

  return (
    <Modal title="When a customer accepts a quote" onClose={() => { if (!busy) onClose(); }} wide>
      {load.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      {load.phase === 'error' ? (
        <div className="space-y-3">
          <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700">{load.error}</p>
          <button type="button" className={buttonClass} onClick={onClose}>Close</button>
        </div>
      ) : null}
      {load.phase === 'ready' && settings !== null ? (
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-fg-strong">What should happen?</legend>
            <p className="text-sm text-fg-muted">This is what the system does the moment a customer presses <strong>Accept quote</strong> on the link in their email.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {ACCEPTANCE_MODES.map((mode) => (
                <ModeCard key={mode} mode={mode} group={`${uid}-mode`} on={settings.onAcceptance === mode} onPick={() => set('onAcceptance', mode)} />
              ))}
            </div>
            <p className="text-xs text-fg-muted">Whatever you choose, a quote that cannot be made automatically stays accepted, the reason is written in its history, and the staff are told it needs them. A customer’s acceptance is never lost.</p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-fg-strong">How should staff be told?</legend>
            <p className="text-sm text-fg-muted">Staff are told every time, whichever you chose above. Switch off the ways you do not want.</p>
            <Switch id={`${uid}-email`} icon={Mail} label="Email" on={settings.notifyEmail} onChange={(v) => set('notifyEmail', v)}>
              Goes to the people chosen under <Link className="font-semibold text-indigo-700 underline" href="/admin/settings/email-routing">Settings, Email routing</Link> (the staff member who made the quote, until you choose others), and to whoever sent the quote.
            </Switch>
            <Switch id={`${uid}-sms`} icon={MessageSquareText} label="Text message" on={settings.notifySms} onChange={(v) => set('notifySms', v)} problem={load.smsConnected ? null : <>No text message provider is connected yet, so nothing can be sent. Connect one under <Link className="font-semibold underline" href="/admin/settings/sms">Settings, Text messages</Link>.</>}>
              Sent to the staff concerned who have a phone number on their account.
            </Switch>
            <Switch id={`${uid}-push`} icon={Bell} label="Browser alert" on={settings.notifyPush} onChange={(v) => set('notifyPush', v)} problem={load.pushAvailable ? null : 'Browser alerts are not set up on this installation yet. Ask whoever runs it to add the push keys.'}>
              Pops up on the phones and computers of the staff concerned who have turned alerts on for their browser.
            </Switch>
          </fieldset>

          {message === null ? null : (
            <p role={message.kind === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 rounded-xl p-3 text-sm ${message.kind === 'error' ? 'border border-red-500/20 bg-red-500/10 text-red-700' : 'bg-emerald-600/10 text-emerald-800'}`} data-testid="acceptance-message">
              {message.kind === 'ok' ? <CheckCircle2 className="size-4 shrink-0" aria-hidden /> : null}{message.text}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>Close</button>
            <button type="button" className={`${primaryClass} min-h-11`} onClick={() => void save()} disabled={busy} data-testid="acceptance-save">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ModeCard({ mode, group, on, onPick }: { mode: AcceptanceMode; group: string; on: boolean; onPick: () => void }) {
  const words = MODE_WORDS[mode];
  return (
    <label className={`flex min-h-28 cursor-pointer gap-3 rounded-2xl border-2 p-4 transition hover:bg-hover ${on ? 'border-indigo-600 bg-indigo-600/5 ring-2 ring-indigo-600/20' : 'border-line bg-surface'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-500`} data-testid={`acceptance-${mode}`}>
      <input type="radio" name={group} value={mode} checked={on} onChange={onPick} className="sr-only" />
      <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-line-strong'}`} aria-hidden>{on ? <span className="size-2 rounded-full bg-white" /> : null}</span>
      <span className="min-w-0 space-y-1">
        <span className="block text-base font-bold text-fg-strong">{words.label}</span>
        <span className="block text-sm text-fg">{words.description}</span>
      </span>
    </label>
  );
}

function Switch({ id, icon: Icon, label, on, onChange, problem, children }: { id: string; icon: typeof Mail; label: string; on: boolean; onChange: (value: boolean) => void; problem?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-line bg-surface p-4">
      <Icon className="mt-0.5 size-5 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={id} className="flex cursor-pointer items-center gap-3 text-base font-bold text-fg-strong">
          <input id={id} type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="size-5 cursor-pointer accent-indigo-600" />
          {label}
        </label>
        <p className="text-sm text-fg">{children}</p>
        {problem === null || problem === undefined ? null : <p className="rounded-lg bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-200" data-testid={`${id}-problem`}>{problem}</p>}
      </div>
    </div>
  );
}
