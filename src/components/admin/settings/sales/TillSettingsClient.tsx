'use client';

import { use, useState } from 'react';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { saveTillSettingsAction, type TillSettingsView, type tillSettingsScreenAction } from '@/server/domains/selling/cash-sales/till-actions';
import type { ReceiptDiscount, TillMode } from '@/server/domains/selling/cash-sales/till-rules';

type Loaded = Awaited<ReturnType<typeof tillSettingsScreenAction>>;

const OPTIONS = [
  { value: 'admin', label: 'Inside the admin page' },
  { value: 'fullscreen', label: 'Full-screen till' },
] as const satisfies readonly { value: TillMode; label: string }[];

const RECEIPT_OPTIONS = [
  { value: 'hidden', label: 'Price charged only' },
  { value: 'total', label: 'Total discount at the end' },
  { value: 'per_item', label: 'Discount on each item' },
] as const satisfies readonly { value: ReceiptDiscount; label: string }[];

export function TillSettingsClient({ firstPromise }: { firstPromise: ReturnType<typeof tillSettingsScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: TillSettingsView }) {
  const [saved, setSaved] = useState({ tillMode: initial.tillMode, receiptDiscount: initial.receiptDiscount });
  const [mode, setMode] = useState<TillMode>(initial.tillMode);
  const [receipt, setReceipt] = useState<ReceiptDiscount>(initial.receiptDiscount);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveTillSettingsAction({ tillMode: mode, receiptDiscount: receipt }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSaved({ tillMode: res.data.tillMode, receiptDiscount: res.data.receiptDiscount });
    setNotice({ kind: 'ok', text: 'Saved. Tills show this the next time Cash Sales is opened.' });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Cash Sales" intro="Choose how the counter looks for everyone who sells at it, and what its receipts say about discounts." />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-4`}>
        <div>
          <h2 className="text-sm font-bold text-fg-strong">How the counter is shown</h2>
          <p className="text-xs text-fg-muted">
            <strong>Inside the admin page</strong> keeps the menu and header around the till (the default). <strong>Full-screen till</strong> gives
            the whole screen to selling: the products and the sale side by side, a big Pay button, with a small top bar for the shift and Exit.
            It suits a till on a tablet or a counter screen.
          </p>
        </div>
        <SegmentedChoice label="Counter display" value={mode} options={OPTIONS} onChange={setMode} />
        <div className="space-y-2 border-t border-line pt-4">
          <h2 className="text-sm font-bold text-fg-strong">Discounts on the receipt</h2>
          <p className="text-xs text-fg-muted">
            <strong>Price charged only</strong> prints each item at the price the customer paid and the total, and nothing about a discount (the default).{' '}
            <strong>Total discount at the end</strong> adds one line near the end of the receipt with everything the customer saved on the sale.{' '}
            <strong>Discount on each item</strong> shows what was taken off under each item that had a discount. It covers discounts typed at the counter
            and discounts from rules, but not a price that was simply changed.
          </p>
          <SegmentedChoice label="Discounts on the receipt" value={receipt} options={RECEIPT_OPTIONS} onChange={setReceipt} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryClass} disabled={busy || (mode === saved.tillMode && receipt === saved.receiptDiscount)} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {mode === saved.tillMode && receipt === saved.receiptDiscount ? <span className="text-xs text-fg-muted">Showing now: {saved.tillMode === 'fullscreen' ? 'full-screen till' : 'inside the admin page'}; receipts show {RECEIPT_OPTIONS.find((o) => o.value === saved.receiptDiscount)?.label.toLowerCase() ?? ''}.</span> : null}
        </div>
      </section>
    </div>
  );
}
