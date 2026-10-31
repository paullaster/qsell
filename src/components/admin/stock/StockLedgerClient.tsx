'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkStockLedgerAction, startStockShadowAction, switchStockLedgerOffAction, switchStockLedgerOnAction, type stockLedgerStatusAction } from '@/server/domains/stock/cutover-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { LedgerStatus } from '@/server/domains/stock/cutover';
import type { ShadowReport } from '@/server/domains/stock/shadow';

const triggerWords = (trigger: string): string => {
  if (trigger === 'nightly') return 'the nightly check';
  return trigger === 'cutover' ? 'at the switch' : 'checked by hand';
};
const count = (report: ShadowReport, key: Count): number => report[key];

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

const MODE_WORDS: Record<LedgerStatus['mode'], { label: string; tone: 'gray' | 'sky' | 'green'; text: string }> = {
  off: { label: 'The old way', tone: 'gray', text: 'Stock is kept as one count per product. Stock by location is not kept.' },
  shadow: { label: 'Shadow', tone: 'sky', text: 'Stock is still kept the old way. Every change is also copied into the new ledger so the two can be compared before anything switches.' },
  ledger: { label: 'The new ledger', tone: 'green', text: 'Stock is kept place by place in the new ledger. Transfers, counts and stock by location work. The product counts follow it.' },
};

type Count = 'onHandDiffers' | 'reservedDiffers' | 'ledgerDiffers' | 'negative' | 'reservationsDiffer' | 'journalDiffers';
const KINDS: [Count, string][] = [
  ['onHandDiffers', 'products whose stock differs from the old count'],
  ['reservedDiffers', 'products whose promised quantity differs'],
  ['ledgerDiffers', 'places where the ledger and the balance disagree'],
  ['negative', 'places holding less than nothing'],
  ['reservationsDiffer', 'places whose promises are not the sum of their holds'],
  ['journalDiffers', 'products whose old journal and ledger disagree'],
];

export function StockLedgerClient({ statusPromise }: { statusPromise: ReturnType<typeof stockLedgerStatusAction> }) {
  const res = use(statusPromise);
  return res.ok ? <View status={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ status }: { status: LedgerStatus }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState('');
  const words = MODE_WORDS[status.mode];
  const run = async (call: Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: success } : { kind: 'error', text: res.error ?? 'Something went wrong. Please try again.' });
    router.refresh();
  };
  const report = status.lastRun?.report ?? null;
  const total = report === null ? 0 : KINDS.reduce((sum, [key]) => sum + count(report, key), 0);

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Stock ledger"
        intro="Moving the company from one stock count per product to stock kept place by place. It happens in steps, with a check before anything switches, and it can be undone while nothing is waiting on it."
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-2`} aria-label="Where the company stands">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-strong">
          How stock is kept now: <Chip tone={words.tone}>{words.label}</Chip>
        </p>
        <p className="text-sm text-fg">{words.text}</p>
      </section>

      {status.mode === 'off' ? (
        <section className={`${cardClass} space-y-3`} aria-label="Step one">
          <h3 className="text-sm font-bold text-fg-strong">Step 1. Start the shadow</h3>
          <p className="text-sm text-fg-muted">Nothing changes for your shop or your staff. From now on every change of stock is also copied into the new ledger, and every product is brought across in the background.</p>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(startStockShadowAction(), 'The shadow has started. Products are being brought across.')}>
            Start the shadow
          </button>
        </section>
      ) : null}

      {status.mode === 'shadow' ? (
        <>
          <section className={`${cardClass} space-y-2`} aria-label="Step two">
            <h3 className="text-sm font-bold text-fg-strong">Step 2. Wait for every product to be brought across</h3>
            <p className="text-sm text-fg">{status.backfillDone ? 'Every product has been brought across.' : 'Products are still being brought across. This runs in the background and needs nothing from you.'}</p>
          </section>
          <section className={`${cardClass} space-y-3`} aria-label="Step three">
            <h3 className="text-sm font-bold text-fg-strong">Step 3. Check that the two sides agree</h3>
            <p className="text-sm text-fg-muted">The check also runs every night. Switch only when it finds nothing different.</p>
            <button type="button" className={buttonClass} disabled={busy || !status.backfillDone} onClick={() => void run(checkStockLedgerAction(), 'Checked.')}>
              Check now
            </button>
          </section>
        </>
      ) : null}

      {status.mode !== 'off' ? (
        <section className={`${cardClass} space-y-2`} aria-label="Latest check">
          <h3 className="text-sm font-bold text-fg-strong">Latest check</h3>
          {status.lastRun === null || report === null ? (
            <p className="text-sm text-fg-muted">No check has been made yet.</p>
          ) : (
            <>
              <p className="text-sm text-fg">
                <time dateTime={status.lastRun.at}>{when(status.lastRun.at)}</time> · {triggerWords(status.lastRun.trigger)} ·{' '}
                {status.lastRun.ok ? <Chip tone="green">Everything agrees</Chip> : <Chip tone="amber">{total} difference{total === 1 ? '' : 's'}</Chip>}
              </p>
              <p className="text-xs text-fg-muted">{report.products} products looked at.</p>
              {status.lastRun.ok ? null : (
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg">
                  {KINDS.filter(([key]) => count(report, key) > 0).map(([key, label]) => (
                    <li key={key}>
                      {count(report, key)} {label}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      ) : null}

      {status.mode === 'shadow' ? (
        <section className={`${cardClass} space-y-3`} aria-label="Step four">
          <h3 className="text-sm font-bold text-fg-strong">Step 4. Switch to the new ledger</h3>
          <p className="text-sm text-fg-muted">
            Orders reserved the old way are given their holds, the two sides are compared one last time, and only if they agree does the switch happen; otherwise nothing changes. Sales that change stock wait for the few seconds it takes, so do it at a quiet hour.
          </p>
          <InlineConfirm label="Switch to the new stock ledger" action="Switch to the new ledger" confirm="Yes, switch now" busy={busy || !status.backfillDone} onConfirm={() => void run(switchStockLedgerOnAction(), 'Switched. Stock is now kept in the new ledger.')} />
          {status.backfillDone ? null : <p className="text-xs text-fg-muted">Available when every product has been brought across.</p>}
        </section>
      ) : null}

      {status.mode === 'ledger' ? (
        <section className={`${cardClass} space-y-3`} aria-label="Going back">
          <h3 className="text-sm font-bold text-fg-strong">Going back to the old way</h3>
          <p className="text-sm text-fg-muted">
            Stock by place stops being kept (it is left as it was) and the product counts carry on. Not possible while the ledger holds stock for orders or transfers on the way, because the old way cannot settle them. Now: {status.open.holds} hold{status.open.holds === 1 ? '' : 's'} for orders and {status.open.transfersOnTheWay} transfer{status.open.transfersOnTheWay === 1 ? '' : 's'} on the way.
          </p>
          <Field id={`${uid}-why`} label="Why go back" hint="Required.">
            <input id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
          <InlineConfirm label="Go back to the old way of keeping stock" action="Go back to the old way" confirm="Yes, go back" busy={busy} onConfirm={() => void run(switchStockLedgerOffAction(reason), 'Back to the old way.')} />
        </section>
      ) : null}
    </div>
  );
}
