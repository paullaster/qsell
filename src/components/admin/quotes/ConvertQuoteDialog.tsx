'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Banknote, Check, CheckCircle2, FileText, HandCoins, Lock, Receipt } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { PayDialog } from '@/components/admin/cash-sales/till/PayDialog';
import { convertQuoteAction, quoteConversionChoicesAction, type QuoteConversionView } from '@/server/domains/quotes/conversion-actions';
import type { QuoteConversion } from '@/server/domains/quotes/service';
import { TARGET_WORDS, type ConversionChoice, type QuoteTarget } from '@/lib/quote-conversion';
import { formatMoney } from '@/lib/credit-note-form';
import { buttonClass, primaryClass } from '@/components/ui/screen-kit';

const ICON: Record<QuoteTarget, typeof FileText> = { sales_order: FileText, sales_invoice: Receipt, credit_sale: HandCoins, cash_sale: Banknote };
const WHERE: Record<QuoteTarget, { href: string; words: string }> = {
  sales_order: { href: '/admin/sales-orders', words: 'Open Sales Orders' },
  sales_invoice: { href: '/admin/sales-invoices', words: 'Open Sales Invoices' },
  credit_sale: { href: '/admin/credit-sales', words: 'Open Credit Sales' },
  cash_sale: { href: '/admin/cash-sales', words: 'Open Cash Sales' },
};

type Load = { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; view: QuoteConversionView };

/**
 * What should this quote become? Four plain choices, each saying what it is for and what will happen (from the company's own settings),
 * and, for one that cannot be chosen, why. Choosing a cash sale goes on to the same payment screen the till uses. The quote's own prices
 * stand in every case. The server decides again when it is confirmed; nothing here is trusted.
 */
export function ConvertQuoteDialog({ quoteId, quoteNumber, onClose, onDone }: { quoteId: string; quoteNumber: string; onClose: () => void; onDone: () => void }) {
  const uid = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [target, setTarget] = useState<QuoteTarget | null>(null);
  const [step, setStep] = useState<'choose' | 'pay' | 'done'>('choose');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState(false);
  const [result, setResult] = useState<QuoteConversion | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void quoteConversionChoicesAction(quoteId).then((r) => {
      if (!current) return;
      setLoad(r.ok ? { phase: 'ready', view: r.data } : { phase: 'error', error: r.error });
    });
    return () => {
      current = false;
    };
  }, [quoteId, attempt]);

  const reload = () => {
    setLoad({ phase: 'loading' });
    setAttempt((n) => n + 1);
  };

  const confirm = async (tenders?: { methodId: string; amount: number; reference: string }[]) => {
    if (target === null || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await convertQuoteAction(quoteId, target, tenders === undefined ? undefined : { tenders });
    setBusy(false);
    if (!r.ok) {
      setProblem(r.error);
      setUnfinished(r.error.includes('press the button again') || r.error.includes('Press the button again'));
      return;
    }
    setResult(r.data);
    setStep('done');
    onDone();
  };

  if (step === 'done' && result !== null) return <Done result={result} quoteNumber={quoteNumber} onClose={onClose} currency={load.phase === 'ready' ? load.view.currency : 'KES'} />;

  if (step === 'pay' && load.phase === 'ready' && target === 'cash_sale') {
    return <PayDialog total={load.view.total} methods={load.view.cashMethods} busy={busy} problem={problem} unfinished={unfinished} onPay={(t) => void confirm(t)} onClose={() => { if (!busy) { setStep('choose'); setProblem(null); } }} />;
  }

  const picked = load.phase === 'ready' ? load.view.choices.find((c) => c.target === target) : undefined;
  let confirmWords = 'Choose what it becomes';
  if (picked !== undefined) confirmWords = picked.target === 'cash_sale' ? 'Continue to payment' : TARGET_WORDS[picked.target].action;
  if (busy) confirmWords = 'Working…';
  const go = () => {
    if (target === 'cash_sale') {
      setProblem(null);
      setStep('pay');
    } else void confirm();
  };

  return (
    <Modal title={`Convert ${quoteNumber}`} onClose={() => { if (!busy) onClose(); }} wide>
      {load.phase === 'loading' ? (
        <div role="status" aria-live="polite" className="space-y-3" data-testid="convert-loading">
          <p className="text-sm text-fg-muted">Checking what {quoteNumber} can become…</p>
          <div className="grid gap-3 md:grid-cols-2" aria-hidden>
            {[0, 1, 2, 3].map((n) => <div key={n} className="h-32 animate-pulse rounded-2xl border border-line bg-hover" />)}
          </div>
        </div>
      ) : null}

      {load.phase === 'error' ? (
        <div className="space-y-3">
          <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700">{load.error}</p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={reload}>Try again</button>
            <button type="button" className={buttonClass} onClick={onClose}>Close</button>
          </div>
        </div>
      ) : null}

      {load.phase === 'ready' ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-sm text-fg-muted">What should this quote become?</p>
            <p className="mt-1 text-lg font-bold text-fg-strong">{load.view.customerName} · <span className="tabular-nums">{formatMoney(load.view.total, load.view.currency)}</span></p>
            <p className="mt-1 text-xs text-fg-muted">The prices stay exactly as they were quoted, whatever the price list says today.</p>
          </div>

          <fieldset className="space-y-3">
            <legend className="sr-only">What the quote becomes</legend>
            <div className="grid gap-3 md:grid-cols-2">
              {load.view.choices.map((choice) => (
                <Card key={choice.target} choice={choice} groupName={`${uid}-target`} on={target === choice.target} onPick={() => { setTarget(choice.target); setProblem(null); }} />
              ))}
            </div>
          </fieldset>

          {picked === undefined ? (
            <p className="text-sm text-fg-muted" data-testid="convert-hint">Choose one above to see what will happen.</p>
          ) : (
            <section aria-live="polite" aria-label="What will happen" className="space-y-3 rounded-2xl border border-indigo-600/30 bg-indigo-600/5 p-4" data-testid="convert-effects">
              <h3 className="text-sm font-bold text-fg-strong">If you choose {picked.label.toLowerCase()}</h3>
              <ul className="space-y-1.5">
                {picked.effects.map((line) => (
                  <li key={line} className="flex gap-2 text-sm text-fg"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />{line}</li>
                ))}
              </ul>
              {picked.cautions.length === 0 ? null : (
                <ul className="space-y-1.5" aria-label="Worth knowing">
                  {picked.cautions.map((line) => (
                    <li key={line} className="flex gap-2 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{line}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {problem === null ? null : <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700" data-testid="convert-problem">{problem}</p>}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className={`${primaryClass} min-h-11`} disabled={picked === undefined || !picked.available || busy} onClick={go} data-testid="convert-confirm">
              {confirmWords}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** One choice: a native radio (so the arrow keys and screen readers work as they should) dressed as a card, with its reason when it cannot be chosen. */
function Card({ choice, groupName, on, onPick }: { choice: ConversionChoice; groupName: string; on: boolean; onPick: () => void }) {
  const Icon = ICON[choice.target];
  const reasonId = `${groupName}-${choice.target}-why`;
  return (
    <label className={`relative flex min-h-32 gap-3 rounded-2xl border-2 p-4 transition ${choice.available ? 'cursor-pointer hover:bg-hover' : 'cursor-not-allowed opacity-70'} ${on ? 'border-indigo-600 bg-indigo-600/5 ring-2 ring-indigo-600/20' : 'border-line bg-surface'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-500`} data-testid={`convert-${choice.target}`}>
      <input type="radio" name={groupName} value={choice.target} checked={on} disabled={!choice.available} onChange={onPick} className="sr-only" aria-describedby={choice.reason === null ? undefined : reasonId} />
      <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${on ? 'bg-indigo-600 text-white' : 'bg-hover text-fg-muted'}`}><Icon className="size-6" aria-hidden /></span>
      <span className="min-w-0 space-y-1">
        <span className="flex items-center gap-2 text-base font-bold text-fg-strong">{choice.label}{on ? <CheckCircle2 className="size-5 text-indigo-600" aria-hidden /> : null}</span>
        <span className="block text-sm text-fg">{choice.forWhen}</span>
        {choice.reason === null ? null : (
          <span id={reasonId} className="flex gap-1.5 text-sm text-amber-800 dark:text-amber-300" data-testid={`convert-${choice.target}-why`}><Lock className="mt-0.5 size-4 shrink-0" aria-hidden />{choice.reason}</span>
        )}
      </span>
    </label>
  );
}

/** What was made: its numbers, what to hand back for a cash sale, and where to find it. */
function Done({ result, quoteNumber, currency, onClose }: { result: QuoteConversion; quoteNumber: string; currency: string; onClose: () => void }) {
  const words = TARGET_WORDS[result.target];
  const where = WHERE[result.target];
  return (
    <Modal title={result.target === 'cash_sale' ? 'Sale complete' : `${words.made} created`} onClose={onClose}>
      <div className="space-y-4" data-testid="convert-done">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-full bg-emerald-600 text-white"><Check className="size-7" aria-hidden /></span>
          <p className="text-base text-fg-strong"><span className="font-bold">{quoteNumber}</span> is now a {words.made.toLowerCase()}.</p>
        </div>
        <dl className="grid gap-2 rounded-2xl border border-line bg-surface p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-fg-muted">{words.made} number</dt><dd className="font-mono font-bold text-fg-strong" data-testid="convert-order-number">{result.orderNumber}</dd></div>
          <div><dt className="text-fg-muted">{result.target === 'cash_sale' ? 'Receipt (tax invoice)' : 'Tax invoice'}</dt><dd className="font-mono font-bold text-fg-strong" data-testid="convert-invoice-number">{result.invoiceNumber ?? 'Not issued yet'}</dd></div>
        </dl>
        {result.receipt === null ? null : (
          <div className="space-y-2 rounded-2xl border border-emerald-600/30 bg-emerald-600/5 p-4" aria-live="polite">
            {result.receipt.changeDue > 0 ? (
              <p className="text-lg font-bold text-fg-strong" data-testid="convert-change">Give the customer {formatMoney(result.receipt.changeDue, currency)} change</p>
            ) : <p className="text-lg font-bold text-fg-strong">Paid in full: {formatMoney(result.receipt.total, currency)}</p>}
            <ul className="text-sm text-fg-muted">{result.receipt.tenders.map((t) => <li key={t.label}>{t.label}: {formatMoney(t.applied, currency)}</li>)}</ul>
            {result.receipt.warning === undefined ? null : <p role="alert" className="text-sm text-amber-800">{result.receipt.warning}</p>}
          </div>
        )}
        {result.waitingForApproval ? <p role="status" className="flex gap-2 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />It is waiting for approval. It goes through, with its stock and invoice, once it is approved.</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={where.href} className={buttonClass}>{where.words}</Link>
          <button type="button" className={`${primaryClass} min-h-11`} onClick={onClose} data-testid="convert-close">Done</button>
        </div>
      </div>
    </Modal>
  );
}
