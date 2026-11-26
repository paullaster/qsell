'use client';

import { use, useState } from 'react';
import { BrandingChoices, type BrandingPreset } from '@/components/admin/settings/BrandingChoices';
import { LoadFailed, Message, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { PLAIN_HEADING, type BrandShow } from '@/lib/print-branding';
import {
  saveRecordPrintAction,
  type RecordPrintScreen,
  type recordPrintScreenAction,
} from '@/server/domains/company/print-branding-actions';

type Loaded = Awaited<ReturnType<typeof recordPrintScreenAction>>;

const PRESETS: readonly BrandingPreset[] = [
  { label: 'Name, phone and email', show: { ...PLAIN_HEADING, phone: true, email: true } },
  { label: 'Business name only', show: PLAIN_HEADING },
];

const same = (a: BrandShow, b: BrandShow): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the top of a printed receipt for one kind of record shows about the business. Saved on its own, apart from the till's other settings. */
export function ReceiptHeadingSection({
  promise,
  record,
}: {
  promise: ReturnType<typeof recordPrintScreenAction>;
  record: 'cash_sale';
}) {
  const res: Loaded = use(promise);
  return res.ok ? <Body initial={res.data} record={record} /> : <LoadFailed error={res.error} />;
}

function Body({ initial, record }: { initial: RecordPrintScreen; record: 'cash_sale' }) {
  const [saved, setSaved] = useState<BrandShow>(initial.show);
  const [show, setShow] = useState<BrandShow>(initial.show);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveRecordPrintAction(record, show));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSaved(res.data.show);
    setShow(res.data.show);
    setNotice({ kind: 'ok', text: 'Saved. Receipts print this heading from the next sale.' });
  };

  return (
    <section className={`${cardClass} max-w-3xl space-y-4`} aria-labelledby="receipt-heading-title">
      <div>
        <h2 id="receipt-heading-title" className="text-sm font-bold text-fg-strong">
          Business details on the receipt
        </h2>
        <p className="text-xs text-fg-muted">
          The receipt always starts with the business name. Choose what goes under it.
        </p>
      </div>
      <BrandingChoices
        profile={initial.profile}
        value={show}
        onChange={setShow}
        presets={PRESETS}
        kind="receipt"
        name="cash-sale-receipt"
      />
      <Message notice={notice} />
      <div>
        <button type="button" className={primaryClass} disabled={busy || same(show, saved)} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
