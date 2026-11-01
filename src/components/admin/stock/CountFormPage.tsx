'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { openStockCountAction } from '@/server/domains/stock/count-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

interface Line {
  key: number;
  product: Choice | null;
}

/** Opens a count. What each product should hold is remembered the moment it opens. */
export function CountFormPage() {
  const uid = useId();
  const router = useRouter();
  const [place, setPlace] = useState<Choice | null>(null);
  const [mode, setMode] = useState<Choice | null>({ id: 'cycle', label: 'Cycle count: some products' });
  const [blind, setBlind] = useState(false);
  const [note, setNote] = useState('');
  const [next, setNext] = useState(2);
  const [lines, setLines] = useState<Line[]>([{ key: 1, product: null }]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const full = mode?.id === 'full';

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(
      openStockCountAction({ locationId: place?.id ?? '', mode: mode?.id ?? '', blind, note, productIds: full ? [] : lines.flatMap((l) => (l.product === null ? [] : [l.product.id])) }),
    );
    setBusy(false);
    if (res.ok) router.push(`/admin/inventory/counts/${res.data.id}`);
    else setNotice({ kind: 'error', text: res.error });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New stock count" intro="Choose the location to count and how. The system remembers what each product should hold at this moment; sales can carry on while you count." />
      <div className={cardClass}>
        <form
          className="space-y-4"
          aria-label="New stock count"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Message notice={notice} />
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoicePicker label="Location to count" source="stock-locations" choice={place} onChoice={setPlace} placeholder="Where the stock is" required />
            <ChoicePicker label="Kind of count" source="stock-count-modes" choice={mode} onChoice={setMode} placeholder="Cycle or full" required />
          </div>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            Blind count: those who count do not see what is expected
          </label>
          {full ? (
            <p className="text-sm text-fg-muted">A full count lists every product the place holds. Anything else found on the shelf can be added while counting.</p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold text-fg">Products to count</legend>
              <ul className="space-y-2">
                {lines.map((l, index) => (
                  <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                    <ChoicePicker label={`Product ${String(index + 1)}`} source="stock-products" choice={l.product} onChoice={(c) => setLines((all) => all.map((x) => (x.key === l.key ? { ...x, product: c } : x)))} placeholder="Search a product by name or SKU" />
                    <button type="button" className={buttonClass} onClick={() => setLines((all) => (all.length === 1 ? all : all.filter((x) => x.key !== l.key)))} disabled={lines.length === 1} aria-label={`Remove product ${String(index + 1)}`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setLines((all) => [...all, { key: next, product: null }]);
                  setNext(next + 1);
                }}
              >
                Add a product
              </button>
            </fieldset>
          )}
          <Field id={`${uid}-note`} label="Note" hint="Optional: why this count, such as the end of the month.">
            <input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} autoComplete="off" maxLength={500} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? 'Opening…' : 'Open the count'}
            </button>
            <button type="button" className={buttonClass} onClick={() => router.push('/admin/inventory/counts')} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
