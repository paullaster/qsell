'use client';

import { useId, useState } from 'react';
import { createStockTransferAction, updateStockTransferAction } from '@/server/domains/stock/transfer-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

export interface TransferDraft {
  id: string;
  version: number;
  from: Choice;
  to: Choice;
  note: string;
  lines: { productId: string; productLabel: string; quantity: number }[];
}

interface LineState {
  key: number;
  product: Choice | null;
  quantity: string;
}

/** Asks for stock to be moved, or changes a draft. Only what the sender holds can be chosen; the server checks it all again. */
export function TransferForm({ draft, onSaved, onCancel }: { draft: TransferDraft | null; onSaved: (id: string) => void; onCancel: () => void }) {
  const uid = useId();
  const [from, setFrom] = useState<Choice | null>(draft?.from ?? null);
  const [to, setTo] = useState<Choice | null>(draft?.to ?? null);
  const [note, setNote] = useState(draft?.note ?? '');
  const [next, setNext] = useState(draft === null ? 2 : draft.lines.length + 1);
  const [lines, setLines] = useState<LineState[]>(draft === null ? [{ key: 1, product: null, quantity: '' }] : draft.lines.map((l, i) => ({ key: i + 1, product: { id: l.productId, label: l.productLabel }, quantity: String(l.quantity) })));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const saveWords = draft === null ? 'Save as a draft' : 'Save changes';
  const patch = (key: number, change: Partial<LineState>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const input = {
      fromLocationId: from?.id ?? '',
      toLocationId: to?.id ?? '',
      note,
      lines: lines.map((l) => ({ productId: l.product?.id ?? '', quantity: l.quantity.trim() === '' ? Number.NaN : Number(l.quantity.trim()) })),
    };
    let id = draft?.id ?? '';
    let problem: string | null = null;
    if (draft === null) {
      const res = await attempt(createStockTransferAction(input));
      if (res.ok) id = res.data.id;
      else problem = res.error;
    } else {
      const res = await attempt(updateStockTransferAction(draft.id, draft.version, input));
      if (!res.ok) problem = res.error;
    }
    setBusy(false);
    if (problem !== null) setNotice({ kind: 'error', text: problem });
    else onSaved(id);
  };

  return (
    <form
      className="space-y-4"
      aria-label={draft === null ? 'New stock transfer' : 'Change stock transfer'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Message notice={notice} />
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoicePicker
          label="Send from"
          source="stock-locations"
          {...(to === null ? {} : { filters: { exclude: to.id } })}
          choice={from}
          onChoice={(c) => {
            setFrom(c);
            setLines((all) => all.map((l) => ({ ...l, product: null })));
          }}
          placeholder="Where the stock is now"
          required
        />
        <ChoicePicker label="Send to" source="stock-locations" {...(from === null ? {} : { filters: { exclude: from.id } })} choice={to} onChoice={setTo} placeholder="Where it is going" required />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-fg">Products to move</legend>
        {from === null ? <p className="text-xs text-fg-muted">Choose where the stock leaves from first. Only products that place holds can be chosen.</p> : null}
        <ul className="space-y-2">
          {lines.map((l, index) => (
            <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-2">
              <ChoicePicker
                label={`Product ${String(index + 1)}`}
                source="stock-products"
                {...(from === null ? {} : { filters: { at: from.id } })}
                choice={l.product}
                onChoice={(c) => patch(l.key, { product: c })}
                placeholder="Search a product by name or SKU"
                disabled={from === null}
              />
              <Field id={`${uid}-q${String(l.key)}`} label={`Quantity ${String(index + 1)}`}>
                <input id={`${uid}-q${String(l.key)}`} inputMode="decimal" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
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
            setLines((all) => [...all, { key: next, product: null, quantity: '' }]);
            setNext(next + 1);
          }}
        >
          Add a product
        </button>
      </fieldset>

      <Field id={`${uid}-note`} label="Note" hint="Optional: what the transfer is for.">
        <input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} autoComplete="off" maxLength={500} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Saving…' : saveWords}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
