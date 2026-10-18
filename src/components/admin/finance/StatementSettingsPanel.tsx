'use client';

import { Suspense, use, useId, useState } from 'react';
import { bankFeedStatusAction, type bankMatchRulesAction, disableBankFeedAction, enableBankFeedAction, saveBankMatchRulesAction } from '@/server/domains/finance/bank-statement-actions';
import { has } from '@/lib/values';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CERTAINTY_CHOICES, SCOPE_WORDS, SUGGEST_CHOICES, describeRules, feedWords, labelOf, toForm, toRules, type RulesForm, type Rules } from '@/lib/bank-match-form';
import { Chip, Field, LoadFailed, Message, PageSkeleton, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from './ui';

type Rule = Extract<Awaited<ReturnType<typeof bankMatchRulesAction>>, { ok: true }>['data'];
type Feed = Extract<Awaited<ReturnType<typeof bankFeedStatusAction>>, { ok: true }>['data'];

export interface SettingsLoads {
  rules: ReturnType<typeof bankMatchRulesAction>;
  feed: ReturnType<typeof bankFeedStatusAction>;
}

/** How lines are matched to our records, and the address a bank can push lines to. Opened from the statement screen. */
export function StatementSettingsPanel({ bankAccountId, loads, onClose }: { bankAccountId: string; loads: SettingsLoads; onClose: () => void }) {
  return (
    <section className={`${cardClass} space-y-5`} aria-label="Matching rules and bank feed">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Matching rules and bank feed</h2>
        <button type="button" className={buttonClass} onClick={onClose}>Close</button>
      </div>
      <Suspense fallback={<PageSkeleton label="matching rules" />}>
        <RulesLoaded bankAccountId={bankAccountId} promise={loads.rules} />
      </Suspense>
      <Suspense fallback={<PageSkeleton label="the bank feed" />}>
        <FeedLoaded bankAccountId={bankAccountId} promise={loads.feed} />
      </Suspense>
    </section>
  );
}

function RulesLoaded({ bankAccountId, promise }: { bankAccountId: string; promise: SettingsLoads['rules'] }) {
  const res = use(promise);
  return res.ok ? <RulesForm bankAccountId={bankAccountId} data={res.data} /> : <LoadFailed error={res.error} />;
}

function RulesForm({ bankAccountId, data }: { bankAccountId: string; data: Rule }) {
  const uid = useId();
  const rules = data.rules as unknown as Rules;
  const [form, setForm] = useState<RulesForm>(toForm(rules));
  const [shown, setShown] = useState<Rules>(rules);
  const [scope, setScope] = useState(data.scope);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = (k: keyof RulesForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (account: string | null) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveBankMatchRulesAction(account, toRules(form)));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setShown(res.data.rules);
    setScope(account === null ? 'company' : 'account');
    setNotice({ kind: 'ok', text: account === null ? 'Saved for every account that has no rules of its own.' : `Saved for this account. ${res.data.matched === null ? '' : `${String(res.data.matched.autoMatched)} matched by themselves, ${String(res.data.matched.proposed)} suggested.`}` });
  };
  return (
    <form className="space-y-3" aria-label="Matching rules" onSubmit={(e) => { e.preventDefault(); void save(bankAccountId); }}>
      <h3 className="text-xs font-bold uppercase text-fg-muted">How lines are matched</h3>
      <p className="text-sm text-fg">{describeRules(shown)}</p>
      <p className="text-xs text-fg-muted">{SCOPE_WORDS[scope]}</p>
      <Message notice={notice} />
      {data.canEdit ? (
        <fieldset className="space-y-3" disabled={busy}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Our reference quoted on the line" source="match-certainty-modes" choice={{ id: form.reference, label: labelOf(CERTAINTY_CHOICES, form.reference) }} onChoice={(c) => set('reference', c?.id ?? 'auto')} clearable={false} required />
            <Field id={`${uid}-ml`} label="Shortest reference to trust (characters)" hint="Short references are too common to prove anything."><input id={`${uid}-ml`} inputMode="numeric" value={form.minRefLength} onChange={(e) => set('minRefLength', e.target.value)} className={fieldClass} required /></Field>
            <ChoicePicker label="The customer's phone number on the line" source="match-certainty-modes" choice={{ id: form.phone, label: labelOf(CERTAINTY_CHOICES, form.phone) }} onChoice={(c) => set('phone', c?.id ?? 'off')} clearable={false} required />
            <ChoicePicker label="The payer's name resembles the customer's" source="match-suggest-modes" choice={{ id: form.name, label: labelOf(SUGGEST_CHOICES, form.name) }} onChoice={(c) => set('name', c?.id ?? 'off')} clearable={false} required />
            <Field id={`${uid}-ns`} label="How alike names must be (0.5 to 1)"><input id={`${uid}-ns`} inputMode="decimal" value={form.nameMinScore} onChange={(e) => set('nameMinScore', e.target.value)} className={fieldClass} required /></Field>
            <Field id={`${uid}-at`} label="Amount may differ by" hint="0.00 means exactly the same. A line that differs is only ever suggested."><input id={`${uid}-at`} inputMode="decimal" value={form.amountTolerance} onChange={(e) => set('amountTolerance', e.target.value)} className={fieldClass} required /></Field>
            <Field id={`${uid}-dw`} label="Dates may be this many days apart"><input id={`${uid}-dw`} inputMode="numeric" value={form.dateWindowDays} onChange={(e) => set('dateWindowDays', e.target.value)} className={fieldClass} required /></Field>
            <Field id={`${uid}-mp`} label="Entries suggested per line (1 to 10)"><input id={`${uid}-mp`} inputMode="numeric" value={form.maxProposals} onChange={(e) => set('maxProposals', e.target.value)} className={fieldClass} required /></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass}>Save for this account</button>
            <button type="button" className={buttonClass} onClick={() => void save(null)}>Save for every account without its own</button>
          </div>
        </fieldset>
      ) : null}
    </form>
  );
}

function FeedLoaded({ bankAccountId, promise }: { bankAccountId: string; promise: SettingsLoads['feed'] }) {
  const res = use(promise);
  return res.ok ? <FeedPanel bankAccountId={bankAccountId} data={res.data} /> : <LoadFailed error={res.error} />;
}

function FeedPanel({ bankAccountId, data }: { bankAccountId: string; data: Feed }) {
  const [status, setStatus] = useState(data.status);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const reload = async () => {
    const res = await attempt(bankFeedStatusAction(bankAccountId));
    if (res.ok) setStatus(res.data.status);
  };
  const enable = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(enableBankFeedAction(bankAccountId));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setAddress(res.data.address);
    await reload();
  };
  const disable = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(disableBankFeedAction(bankAccountId));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setAddress(null);
    setNotice({ kind: 'ok', text: 'Switched off. The old address no longer works.' });
    await reload();
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: 'ok', text: 'Copied.' });
    } catch {
      setNotice({ kind: 'error', text: 'Could not copy. Select the address and copy it by hand.' });
    }
  };
  return (
    <div className="space-y-3" aria-label="Bank feed">
      <h3 className="text-xs font-bold uppercase text-fg-muted">Bank feed</h3>
      <p className="text-sm text-fg">A bank, an aggregator or a small script can send this account&apos;s statement lines to a private address as they happen, instead of someone importing a file. Lines are checked, kept once and matched like any import.</p>
      <p className="flex flex-wrap items-center gap-2 text-sm"><Chip tone={feedTone(status)}>{feedWord(status)}</Chip><span className="text-fg-muted">{feedWords(status, new Date())}</span></p>
      {has(status?.lastError) ? <p role="alert" className="break-words text-sm text-red-700">The last delivery was refused: {status.lastError}</p> : null}
      <Message notice={notice} />
      {address !== null ? (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" role="status">
          <p className="text-sm font-semibold text-fg-strong">This is the only time the address is shown. Keep it as safe as a password: anyone with it can add lines to this account.</p>
          <p className="break-all rounded bg-surface-sunken p-2 font-mono text-xs">{address}</p>
          <button type="button" className={buttonClass} onClick={() => void copy(address)}>Copy the address</button>
          <p className="text-xs text-fg-muted">Send a POST with JSON like <code className="font-mono">{'{"lines":[{"date":"2026-10-16","amount":"500.00","reference":"ABC123","description":"Deposit"}]}'}</code>. Money out is a negative amount. A delivery sent twice changes nothing the second time.</p>
        </div>
      ) : null}
      {data.canManage ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void enable()}>{status === null ? 'Make a feed' : 'Make a new address'}</button>
          {status?.enabled === true ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void disable()}>Switch off</button> : null}
        </div>
      ) : null}
      {status !== null && data.canManage ? <p className="text-xs text-fg-muted">A new address stops the old one working at once. Its secret ends in <span className="font-mono">{status.hint}</span>.</p> : null}
    </div>
  );
}

const feedTone = (s: { enabled: boolean } | null): 'gray' | 'green' | 'red' => {
  if (s === null) return 'gray';
  return s.enabled ? 'green' : 'red';
};
const feedWord = (s: { enabled: boolean } | null): string => {
  if (s === null) return 'No feed';
  return s.enabled ? 'On' : 'Off';
};
