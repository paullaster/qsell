'use client';

import { useId, useState } from 'react';
import type { EtimsItemView } from '@/server/domains/kra/etims/actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { buttonClass, Chip, fieldClass } from '@/components/ui/screen-kit';
import { STATUS_TONE, stockChanged } from '@/lib/etims-forms';
import { has } from '@/lib/values';

interface Props {
  item: EtimsItemView;
  disabled: boolean;
  onStock: (quantity: number) => void;
  onResync: () => void;
  onReconcile: () => void;
  onDelete: () => void;
}

export function EtimsItemCard({ item, disabled, onStock, onResync, onReconcile, onDelete }: Props) {
  const uid = useId();
  const [stock, setStock] = useState(String(item.stockQuantity));
  const confirmed = item.status === 'registered';
  const facts: [string, string][] = [
    ['Tax code', item.taxCode],
    ['Units (qty / pkg)', `${item.qtyUnitCode} / ${item.pkgUnitCode}`],
    ['Class', item.itemClassCode],
    ['Price', item.unitPrice.toLocaleString()],
  ];

  return (
    <article className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-fg-strong">{item.productName}</h3>
          <p className="text-xs text-fg-muted">
            {item.sku} · KRA code <span className="font-mono">{item.kraItemCode ?? 'not assigned'}</span>
          </p>
        </div>
        <Chip tone={STATUS_TONE[item.status]}>{item.status}</Chip>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-fg-muted">{k}</dt>
            <dd className="font-mono text-fg-strong">{v}</dd>
          </div>
        ))}
      </dl>

      {has(item.errorMessage) ? (
        <p role="alert" className="text-xs text-red-700">
          {item.errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        {confirmed ? (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${uid}-st`} className="mb-1 block text-xs font-semibold text-fg">
                Stock at KRA
              </label>
              <input id={`${uid}-st`} type="number" min={0} step={1} value={stock} onChange={(e) => setStock(e.target.value)} className={`${fieldClass} w-28`} />
            </div>
            <button type="button" className={buttonClass} disabled={disabled || !stockChanged(stock, item.stockQuantity)} onClick={() => onStock(Number(stock))}>
              Update stock
            </button>
            <button type="button" className={buttonClass} disabled={disabled} onClick={onResync}>
              Re-sync details
            </button>
          </div>
        ) : null}
        {item.status === 'unconfirmed' ? (
          <button type="button" className={buttonClass} disabled={disabled} onClick={onReconcile}>
            Find KRA code
          </button>
        ) : null}
        {item.status !== 'pending' && item.status !== 'unconfirmed' ? <InlineConfirm label={`Delete ${item.productName} from KRA`} action="Delete" confirm="Delete at KRA" busy={disabled} onConfirm={onDelete} /> : null}
      </div>
    </article>
  );
}
