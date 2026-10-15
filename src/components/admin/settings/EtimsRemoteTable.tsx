'use client';

import { useState } from 'react';
import type { RemoteEtimsItem } from '@/server/domains/kra/etims/item-service';
import { buttonClass } from '@/components/ui/screen-kit';
import { has } from '@/lib/values';

const SHOWN = 50;

/** What KRA itself holds, fifty rows at a time (the gateway answers with the whole list at once). */
export function EtimsRemoteTable({ items }: { items: RemoteEtimsItem[] }) {
  const [shown, setShown] = useState(SHOWN);
  if (items.length === 0) return <p className="text-sm text-fg-subtle">KRA reports no items.</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[32rem] text-left text-xs">
          <caption className="sr-only">Items registered at KRA for this branch</caption>
          <thead className="border-b border-line bg-surface/70 text-fg-muted uppercase">
            <tr>
              <th scope="col" className="px-3 py-2">Code</th>
              <th scope="col" className="px-3 py-2">Name</th>
              <th scope="col" className="px-3 py-2">Stock</th>
              <th scope="col" className="px-3 py-2">In this app</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {items.slice(0, shown).map((i, idx) => (
              <tr key={i.itemCode ?? idx}>
                <td className="px-3 py-2 font-mono">{i.itemCode ?? '—'}</td>
                <td className="px-3 py-2">{i.name ?? '—'}</td>
                <td className="px-3 py-2">{i.stock ?? '—'}</td>
                <td className="px-3 py-2">{has(i.localItemId) ? 'Linked' : 'Not linked'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < items.length ? (
        <button type="button" className={buttonClass} onClick={() => setShown(shown + SHOWN)}>
          Show more of KRA’s {items.length} items
        </button>
      ) : null}
    </div>
  );
}
