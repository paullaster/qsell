'use client';

import { use, useEffect, useState } from 'react';
import { setStockTimingAction, stockReissueApplyAction, stockReissuePreviewAction, type stockTimingAction } from '@/server/domains/delivery/document-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { IssueMoment } from '@/lib/stock-issue';

type Loaded = Awaited<ReturnType<typeof stockTimingAction>>;

export function StockTimingClient({ viewPromise }: { viewPromise: ReturnType<typeof stockTimingAction> }) {
  const res: Loaded = use(viewPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Extract<Loaded, { ok: true }>['data'] }) {
  const [saved, setSaved] = useState<IssueMoment>(initial.moment);
  const [chosen, setChosen] = useState<IssueMoment>(initial.moment);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const choice = { id: chosen, label: initial.options.find((o) => o.id === chosen)?.name ?? chosen };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(setStockTimingAction({ moment: chosen }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setSaved(result.data.moment);
    setNotice({ kind: 'ok', text: 'Saved. It applies to orders paid from now on; orders already paid keep what they had.' });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Stock timing" intro="When the stock of an order that is delivered leaves the shelf. Collected orders always leave when they are paid." />
      <Message notice={notice} />
      {initial.byLocation ? null : (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Stock is not yet kept by location, so it leaves when the order is paid. The other two choices need stock to be kept by location first.
        </p>
      )}
      <section className={`${cardClass} space-y-3`} aria-label="When stock leaves">
        <ChoicePicker label="The stock of a delivered order leaves the shelf" source="stock-issue-moments" choice={choice} onChoice={(c) => setChosen(c === null ? saved : (c.id as IssueMoment))} disabled={!initial.canChange} />
        <p className="text-xs text-fg-muted">{initial.options.find((o) => o.id === chosen)?.means}</p>
        <p className="text-xs text-fg-muted">
          In use now: <Chip tone="green">{initial.options.find((o) => o.id === saved)?.name}</Chip>
        </p>
        {initial.canChange ? (
          <button type="button" className={primaryClass} disabled={busy || chosen === saved} onClick={() => void save()}>
            Save
          </button>
        ) : (
          <p className="text-xs text-fg-muted">You can look at this, but changing it needs the stock switch-over permission.</p>
        )}
      </section>
      {saved !== 'payment' && initial.canChange ? <ReissuePanel saved={saved} /> : null}
    </div>
  );
}

type Preview = Extract<Awaited<ReturnType<typeof stockReissuePreviewAction>>, { ok: true }>['data'];

/**
 * Orders paid before the choice was made had their stock taken off the shelf at payment. For the goods that have not left yet, this
 * counts the stock back and holds it for the order's deliveries, so the order behaves like one paid today.
 */
function ReissuePanel({ saved }: { saved: IssueMoment }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void stockReissuePreviewAction().then((r) => {
      if (cancelled) return;
      if (r.ok) setPreview(r.data);
      else setNotice({ kind: 'error', text: r.error });
    });
    return () => {
      cancelled = true;
    };
  }, [saved, version]);

  const apply = async () => {
    setBusy(true);
    setNotice(null);
    let orders = 0;
    let quantity = 0;
    const skipped: { orderId: string; orderNumber: string; message: string }[] = [];
    let failed: string | null = null;
    for (let batch = 0; batch < 200; batch += 1) {
      const result = await attempt(stockReissueApplyAction({ skip: skipped.map((s) => s.orderId) }));
      if (!result.ok) {
        failed = result.error;
        break;
      }
      orders += result.data.orders;
      quantity += result.data.quantity;
      skipped.push(...result.data.skipped);
      if (result.data.remaining === 0) break;
    }
    setBusy(false);
    setVersion((v) => v + 1);
    if (failed !== null) {
      setNotice({ kind: 'error', text: failed });
      return;
    }
    const left = skipped.length === 0 ? '' : ` ${String(skipped.length)} could not be changed: ${skipped.slice(0, 5).map((s) => `${s.orderNumber} (${s.message})`).join('; ')}${skipped.length > 5 ? '; and more' : ''}`;
    setNotice({ kind: skipped.length === 0 ? 'ok' : 'error', text: `Done. ${String(orders)} ${orders === 1 ? 'order' : 'orders'} changed, ${String(quantity)} counted back and held for their deliveries.${left}` });
  };

  return (
    <section aria-label="Orders already paid" className={`${cardClass} space-y-3`}>
      <h2 className="text-sm font-bold text-fg-strong">Orders already paid</h2>
      <Message notice={notice} />
      {preview === null ? (
        <p role="status" className="text-xs text-fg-muted">
          Looking for orders paid before this choice…
        </p>
      ) : null}
      {preview?.orders === 0 ? (
        <p role="status" className="text-xs text-fg-muted">
          No order paid before this choice has goods still to leave. Nothing to change.
        </p>
      ) : null}
      {preview !== null && preview.orders > 0 ? (
        <>
          <p role="status" className="text-xs text-fg-muted">
            {preview.atLeast ? 'At least ' : ''}
            {preview.orders} {preview.orders === 1 ? 'order was' : 'orders were'} paid before this choice, with {preview.quantity} {preview.quantity === 1 ? 'item' : 'items'} that {preview.quantity === 1 ? 'has' : 'have'} not left yet. Their stock was taken off the shelf when they were paid. This counts it back and holds it for their deliveries, so they behave like an order paid today. Goods already sent stay as they are.
          </p>
          <InlineConfirm label="Apply the choice to orders already paid" action="Apply to these orders" confirm="Yes, change them" busy={busy} onConfirm={() => void apply()} />
        </>
      ) : null}
    </section>
  );
}
