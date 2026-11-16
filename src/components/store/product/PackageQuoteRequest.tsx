'use client';

import { useEffect, useId, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { PackagePick } from '@/lib/package-cart';
import { quoteContactAction, requestPackageQuoteAction } from '@/server/domains/pricing/package-quote-actions';

export interface QuoteChoice {
  picks: PackagePick[];
  servings: number;
  note: string;
}

const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none';
const label = 'mb-1 block text-sm font-medium text-fg-muted';

/**
 * The "Request a quote" form under a package builder: who to send it to and when it is needed. The choices are sent as ids and counts;
 * the server prices them and makes the quote. A signed-in shopper's details are filled in from their account.
 */
export function PackageQuoteRequest({ productId, choice, onCancel }: { productId: string; choice: QuoteChoice; onCancel: () => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [neededOn, setNeededOn] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void quoteContactAction().then((answer) => {
      if (!live || !answer.ok || answer.data === null) return;
      setName((current) => (current === '' ? answer.data?.name ?? '' : current));
      setEmail((current) => (current === '' ? answer.data?.email ?? '' : current));
      setPhone((current) => (current === '' ? answer.data?.phone ?? '' : current));
    });
    return () => {
      live = false;
    };
  }, []);

  if (sent !== null) {
    return (
      <div role="status" data-testid="quote-requested" className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-fg">
        <p className="flex items-center gap-2 font-semibold text-fg-strong">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          We have your request: quote {sent}
        </p>
        <p className="text-fg-muted">We will check it and send you the price. You can then accept the quote and we will prepare the order.</p>
      </div>
    );
  }

  const send = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await requestPackageQuoteAction({ productId, picks: choice.picks, servings: choice.servings, note: choice.note, name, email, phone, neededOn, message });
    setBusy(false);
    if (answer.ok) setSent(answer.data.quoteNumber);
    else setProblem(answer.error);
  };

  return (
    <form
      data-testid="quote-request-form"
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h3 className="text-base font-semibold text-fg-strong">Request a quote</h3>
      <p className="text-sm text-fg-muted">
        For {choice.servings} {choice.servings === 1 ? 'serving' : 'servings'} as you chose. Tell us where to send it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-name`} className={label}>Your name</label>
          <input id={`${id}-name`} className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" required />
        </div>
        <div>
          <label htmlFor={`${id}-email`} className={label}>Email</label>
          <input id={`${id}-email`} className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} autoComplete="email" />
        </div>
        <div>
          <label htmlFor={`${id}-phone`} className={label}>Phone</label>
          <input id={`${id}-phone`} className={field} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} autoComplete="tel" />
        </div>
        <div>
          <label htmlFor={`${id}-day`} className={label}>Needed on (optional)</label>
          <input id={`${id}-day`} className={field} type="date" value={neededOn} onChange={(e) => setNeededOn(e.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-message`} className={label}>Anything we should know (optional)</label>
        <textarea id={`${id}-message`} className={`${field} min-h-20`} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
      </div>
      <p className="text-xs text-fg-subtle">Give an email address or a phone number, so we can reach you.</p>
      {problem === null ? null : <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="min-h-11 cursor-pointer rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 cursor-pointer rounded-xl border border-line-strong bg-surface-sunken px-5 py-2.5 text-sm font-semibold text-fg-strong hover:bg-hover">
          Cancel
        </button>
      </div>
    </form>
  );
}
