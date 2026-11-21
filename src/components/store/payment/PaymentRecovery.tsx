'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { CheckCircle2, CreditCard, ReceiptText } from 'lucide-react';
import type { ClaimAnswer, PayOptions } from '@/server/domains/payments/payment-claims';
import { formatAmount } from '@/lib/storefront-account';
import { callsFor, type Answer, type RecoveryMode } from './payment-recovery-calls';

const POLL_MS = 3000;
const POLL_LIMIT = 40;
const inputClass = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const primaryClass = 'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60';

type Method = PayOptions['methods'][number];
type Panel = 'claim' | 'again' | null;

/** Words and colour for where a claimed payment has got to. */
function toneOf(stage: ClaimAnswer['stage']): string {
  if (stage === 'confirmed') return 'border-green-500/40 bg-green-500/10';
  if (stage === 'checking') return 'border-sky-500/40 bg-sky-500/10';
  if (stage === 'held' || stage === 'saved' || stage === 'unavailable') return 'border-amber-500/40 bg-amber-500/10';
  return 'border-red-500/40 bg-red-500/10';
}

function MethodChoice({ legend, methods, value, onChange, name }: { legend: string; methods: readonly Method[]; value: string; onChange: (code: string) => void; name: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-fg">{legend}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {methods.map((m) => (
          <label key={m.code} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${value === m.code ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}>
            <input type="radio" name={name} value={m.code} checked={value === m.code} onChange={() => onChange(m.code)} className="h-4 w-4 accent-indigo-600" />
            <span className="font-medium text-fg-strong">{m.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * What a shopper can do about an order whose payment is not yet counted: say they already paid, and give the provider's code, or pay
 * again. It never edits the order; the order is only read. Both ways end in the shop's own server asking the provider, never in the
 * browser's word.
 */
export function PaymentRecovery({ mode, orderNumber }: { mode: RecoveryMode; orderNumber: string }) {
  const uid = useId();
  const router = useRouter();
  const [calls] = useState(() => callsFor(mode));
  const [options, setOptions] = useState<PayOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [method, setMethod] = useState('');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ClaimAnswer | null>(null);
  const [notice, setNotice] = useState<{ words: string; redirectUrl: string | null } | null>(null);
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  // What can be done is asked of the server when the screen opens, and the payments the shop started for this order are read again at
  // the same time: a missed answer is often all that was wrong, and then the order is simply paid.
  useEffect(() => {
    live.current = true;
    void Promise.all([calls.options(), calls.refresh()]).then(([o, r]) => {
      if (!live.current) return;
      if (r.ok && r.data.paid) {
        setPaid(true);
        router.refresh();
        return;
      }
      if (o.ok) {
        setOptions(o.data);
        setMethod(o.data.methods.find((m) => m.canLookUpByCode)?.code ?? o.data.methods.at(0)?.code ?? '');
      } else setLoadError(o.error);
    });
    return () => {
      live.current = false;
      stop();
    };
  }, [calls, router]);

  const open = (next: Panel) => {
    stop();
    setPanel((current) => (current === next ? null : next));
    setProblem(null);
    setAnswer(null);
    setNotice(null);
  };

  /** Asks how a claim is getting on, again and again, until it is decided or the wait is over. */
  const follow = (attemptId: string, round: number) => {
    timer.current = setTimeout(() => {
      void calls.status(attemptId).then((r) => {
        if (!live.current) return;
        if (!r.ok) {
          setProblem(r.error);
          return;
        }
        setAnswer(r.data);
        if (r.data.stage === 'confirmed') {
          setPaid(true);
          router.refresh();
        } else if (!r.data.done && round < POLL_LIMIT) follow(attemptId, round + 1);
      });
    }, POLL_MS);
  };

  const finish = (r: Answer<ClaimAnswer>) => {
    setBusy(false);
    if (!r.ok) {
      setProblem(r.error);
      return;
    }
    setAnswer(r.data);
    if (r.data.stage === 'confirmed') {
      setPaid(true);
      router.refresh();
    } else if (!r.data.done && r.data.attemptId !== null) follow(r.data.attemptId, 1);
  };

  const sendClaim = (event: SyntheticEvent) => {
    event.preventDefault();
    stop();
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    void calls.claim(method, code).then(finish);
  };

  /** After a payment prompt, the shop is asked again and again whether the provider has told it the payment is done. */
  const waitForPayment = (round: number) => {
    timer.current = setTimeout(() => {
      void calls.refresh().then((r) => {
        if (!live.current) return;
        if (r.ok && r.data.paid) {
          setPaid(true);
          router.refresh();
        } else if (round < POLL_LIMIT) waitForPayment(round + 1);
      });
    }, POLL_MS);
  };

  const sendAgain = (event: SyntheticEvent) => {
    event.preventDefault();
    stop();
    setBusy(true);
    setProblem(null);
    setNotice(null);
    void calls.payAgain(method, phone).then((r) => {
      setBusy(false);
      if (!r.ok) {
        setProblem(r.error);
        return;
      }
      if (r.data.kind === 'paid') {
        setPaid(true);
        router.refresh();
      } else if (r.data.kind === 'failed') setProblem(r.data.message);
      else if (r.data.kind === 'none') setProblem('Nothing was started. Please choose how you will pay.');
      else {
        setNotice({ words: r.data.message, redirectUrl: r.data.kind === 'hosted' ? r.data.redirectUrl : null });
        waitForPayment(1);
      }
    });
  };

  if (paid) {
    return (
      <section aria-label="Payment received" className="rounded-xl border border-green-500/40 bg-green-500/10 p-4 sm:p-5">
        <p role="status" className="flex items-start gap-2 text-sm font-semibold text-fg-strong">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
          <span>Thank you. We have your payment for order {orderNumber}.</span>
        </p>
      </section>
    );
  }
  if (loadError !== null) {
    return (
      <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
        {loadError}
      </p>
    );
  }
  if (options === null) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Checking your payment…
      </p>
    );
  }
  if (!options.payable.ok) {
    return (
      <p role="status" className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-fg">
        {options.payable.reason}
      </p>
    );
  }
  if (options.methods.length === 0) {
    return (
      <p role="status" className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-fg">
        Online payment is not available right now. Please contact the shop with your order number, {orderNumber}.
      </p>
    );
  }

  const chosen = options.methods.find((m) => m.code === method);
  return (
    <section aria-label="Complete your payment" className="space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold text-fg-strong">Complete your payment</h2>
        <p className="mt-1 text-sm text-fg-muted">
          We have not yet received the payment of {formatAmount(options.amountDue, options.currency)} for this order. Your order cannot be changed here; choose what applies.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" aria-expanded={panel === 'claim'} aria-controls={`${uid}-claim`} onClick={() => open('claim')} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 text-left text-sm ${panel === 'claim' ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}>
          <ReceiptText className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" aria-hidden="true" />
          <span>
            <span className="block font-semibold text-fg-strong">I have already paid and have the transaction code</span>
            <span className="block text-xs text-fg-muted">We will check it with the provider.</span>
          </span>
        </button>
        <button type="button" aria-expanded={panel === 'again'} aria-controls={`${uid}-again`} onClick={() => open('again')} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 text-left text-sm ${panel === 'again' ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}>
          <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" aria-hidden="true" />
          <span>
            <span className="block font-semibold text-fg-strong">Pay again</span>
            <span className="block text-xs text-fg-muted">Choose how you will pay and we will start the payment.</span>
          </span>
        </button>
      </div>

      {panel === 'claim' ? (
        <form id={`${uid}-claim`} onSubmit={sendClaim} aria-label="I have already paid" className="space-y-4">
          <MethodChoice legend="How did you pay?" methods={options.methods} value={method} onChange={setMethod} name={`${uid}-claim-method`} />
          <div>
            <label htmlFor={`${uid}-code`} className="mb-1 block text-sm font-medium text-fg">
              Transaction code
            </label>
            <input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} className={`${inputClass} font-mono uppercase`} placeholder={chosen?.code === 'mpesa_daraja' ? 'For example QGH7RT61SV' : 'From your payment message'} aria-describedby={`${uid}-code-hint`} />
            <p id={`${uid}-code-hint`} className="mt-1 text-xs text-fg-muted">
              Copy it from the message you got after paying{chosen === undefined ? '' : ` with ${chosen.label}`}. It is checked with the provider; nothing about your order changes.
            </p>
          </div>
          <button type="submit" disabled={busy || method === '' || code.trim() === ''} className={primaryClass}>
            {busy ? 'Checking…' : 'Check my payment'}
          </button>
        </form>
      ) : null}

      {panel === 'again' ? (
        <form id={`${uid}-again`} onSubmit={sendAgain} aria-label="Pay again" className="space-y-4">
          <MethodChoice legend="How will you pay?" methods={options.methods} value={method} onChange={setMethod} name={`${uid}-again-method`} />
          {chosen?.usesPhone === true ? (
            <div>
              <label htmlFor={`${uid}-phone`} className="mb-1 block text-sm font-medium text-fg">
                Mobile number to pay from (optional)
              </label>
              <input id={`${uid}-phone`} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" className={`${inputClass} font-mono`} placeholder="07XX XXX XXX" aria-describedby={`${uid}-phone-hint`} />
              <p id={`${uid}-phone-hint`} className="mt-1 text-xs text-fg-muted">
                Leave it empty to use the number on this order.
              </p>
            </div>
          ) : null}
          <button type="submit" disabled={busy || method === ''} className={primaryClass}>
            {busy ? 'Starting…' : `Pay ${formatAmount(options.amountDue, options.currency)}`}
          </button>
        </form>
      ) : null}

      <div aria-live="polite" className="space-y-2">
        {problem === null ? null : (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
            {problem}
          </p>
        )}
        {answer === null ? null : (
          <p role="status" className={`rounded-lg border p-3 text-sm text-fg-strong ${toneOf(answer.stage)}`}>
            {answer.message}
          </p>
        )}
        {notice === null ? null : (
          <div role="status" className="space-y-2 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-fg-strong">
            <p>{notice.words}</p>
            {notice.redirectUrl === null ? null : (
              <Link href={notice.redirectUrl} className={primaryClass}>
                Open the payment page
              </Link>
            )}
            <p className="text-xs text-fg-muted">We will show your payment here as soon as the provider tells us it is done.</p>
          </div>
        )}
      </div>
    </section>
  );
}
