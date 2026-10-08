'use client';

import { useEffect, useId, useState } from 'react';
import { searchCustomersAction } from '@/server/domains/pricing/actions';
import { buttonClass, fieldClass, labelClass } from '../approvals/shared';

export interface PickedCustomer {
  id: string;
  number: string;
  name: string;
}

/** Finds one customer by name or number. */
export function CustomerLookup({
  value,
  onChange,
  label = 'Customer',
}: {
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
  label?: string;
}) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PickedCustomer[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void searchCustomersAction(q).then((r) => {
        if (live && r.ok) setFound(r.data);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  if (value)
    return (
      <div>
        <span className={labelClass}>{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg-strong">
            {value.name} <span className="font-normal text-fg-muted">{value.number}</span>
          </span>
          <button type="button" className={buttonClass} onClick={() => onChange(null)}>
            Choose another
          </button>
        </div>
      </div>
    );
  return (
    <div>
      <label htmlFor={uid} className={labelClass}>
        {label}
      </label>
      <input
        id={uid}
        className={`${fieldClass} sm:max-w-sm`}
        value={q}
        placeholder="Type a name or number…"
        onChange={(e) => setQ(e.target.value)}
      />
      {found.length > 0 ? (
        <ul className="mt-1 max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line sm:max-w-sm">
          {found.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover"
                onClick={() => {
                  onChange(f);
                  setQ('');
                  setFound([]);
                }}
              >
                {f.name} <span className="text-fg-muted">{f.number}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
