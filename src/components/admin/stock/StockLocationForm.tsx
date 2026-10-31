'use client';

import { useId, useState } from 'react';
import { createStockLocationAction, updateStockLocationAction, type LocationView } from '@/server/domains/stock/location-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { SALES_CHANNELS, type SalesChannel } from '@/lib/stock';
import type { Choice } from '@/lib/payment-options';

const CHANNEL_WORDS: Record<SalesChannel, string> = {
  ecommerce: 'The web shop',
  sales_order: 'Sales orders',
  credit_sale: 'Credit sales',
  pos_cash_sale: 'Point of sale',
};
const KIND_WORDS: Record<string, string> = {
  warehouse: 'Warehouse',
  store: 'Shop or store',
  van: 'Van or vehicle',
  quarantine: 'Quarantine',
  damaged: 'Damaged or scrap',
  consignment_in: 'Consignment (held for a supplier)',
};
/** Kinds that are never sold from, whatever else is chosen. */
const NEVER_SOLD = ['quarantine', 'damaged'];

/** Adds a stock location, or changes one. The server checks everything again; this only saves a round trip. */
export function StockLocationForm({ location, autoFocus, onCancel, onSaved }: { location: LocationView | null; autoFocus?: boolean; onCancel: () => void; onSaved: (saved: { id: string; code: string; name: string }) => void }) {
  const uid = useId();
  const [code, setCode] = useState(location?.code ?? '');
  const [name, setName] = useState(location?.name ?? '');
  const [kind, setKind] = useState<Choice | null>(location === null ? { id: 'warehouse', label: KIND_WORDS.warehouse ?? 'Warehouse' } : { id: location.kind, label: KIND_WORDS[location.kind] ?? location.kind });
  const [branch, setBranch] = useState<Choice | null>(location?.branchId == null ? null : { id: location.branchId, label: location.branchName ?? 'Branch' });
  const [address, setAddress] = useState(location?.address ?? '');
  const [channels, setChannels] = useState<SalesChannel[]>(location === null ? [...SALES_CHANNELS] : (location.sellsChannels as SalesChannel[]));
  const [sellable, setSellable] = useState(location?.isSellable ?? true);
  const [delivers, setDelivers] = useState(location?.fulfilsDelivery ?? true);
  const [negative, setNegative] = useState(location?.allowNegative ?? false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const kindId = kind?.id ?? '';
  const cannotSell = NEVER_SOLD.includes(kindId);
  const saveWords = location === null ? 'Add location' : 'Save changes';

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const input = { code, name, kind: kindId, branchId: branch?.id ?? '', address, isSellable: cannotSell ? false : sellable, sellsChannels: channels, fulfilsDelivery: delivers, allowNegative: negative };
    const res = await attempt(location === null ? createStockLocationAction(input) : updateStockLocationAction(location.id, input));
    setBusy(false);
    if (res.ok) onSaved(location === null && 'data' in res ? (res.data as { id: string; code: string; name: string }) : { id: location?.id ?? '', code, name });
    else setNotice({ kind: 'error', text: res.error });
  };

  return (
    <form
      className="space-y-3"
      aria-label={location === null ? 'New stock location' : `Edit ${location.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Message notice={notice} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${uid}-code`} label="Code" hint="Short and unique, such as MAIN or NAIROBI-1.">
          <input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} className={fieldClass} autoComplete="off" maxLength={20} autoFocus={autoFocus} />
        </Field>
        <Field id={`${uid}-name`} label="Name">
          <input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} autoComplete="off" maxLength={120} />
        </Field>
        <ChoicePicker label="Kind of place" source="stock-location-kinds" choice={kind} onChoice={setKind} placeholder="Choose a kind" required />
        <ChoicePicker label="Branch" source="branches" choice={branch} onChoice={setBranch} placeholder="No branch (company stock)" clearable />
        <div className="sm:col-span-2">
          <Field id={`${uid}-address`} label="Address" hint="Where goods leave from: used for deliveries.">
            <input id={`${uid}-address`} value={address} onChange={(e) => setAddress(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
        </div>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-fg">Can be sold from here</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={cannotSell ? false : sellable} disabled={cannotSell} onChange={(e) => setSellable(e.target.checked)} />
          Stock here counts as available to sell
        </label>
        {cannotSell ? <p className="text-[11px] text-fg-muted">Stock in a {(KIND_WORDS[kindId] ?? kindId).toLowerCase()} place is never sold from.</p> : null}
        {sellable && !cannotSell ? (
          <div className="flex flex-wrap gap-x-4">
            {SALES_CHANNELS.map((ch) => (
              <label key={ch} className="flex min-h-10 items-center gap-2 text-sm text-fg">
                <input type="checkbox" checked={channels.includes(ch)} onChange={(e) => setChannels((all) => (e.target.checked ? [...all, ch] : all.filter((x) => x !== ch)))} />
                {CHANNEL_WORDS[ch]}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={delivers} onChange={(e) => setDelivers(e.target.checked)} />
        Deliveries can leave from here
      </label>
      <div>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          Allow stock to go below zero here
        </label>
        <p className="text-[11px] text-fg-muted">For a till that sells before the delivery is booked in. Every other place refuses a sale of stock that is not there.</p>
      </div>
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
