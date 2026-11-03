'use client';

import { use, useState } from 'react';
import { setStockTimingAction, type stockTimingAction } from '@/server/domains/delivery/document-actions';
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
    </div>
  );
}
