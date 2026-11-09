'use client';

import { useId, useState } from 'react';
import { Tag, X } from 'lucide-react';
import type { ShopBasketView } from '@/server/domains/orders/shop-basket-actions';

const inputClass = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-mono uppercase text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

/** A place to type a promo code. The server decides whether each code can be used and what it takes off; this only keeps the list. */
export function PromoCode({ codes, onCodes, basket }: { codes: string[]; onCodes: (next: string[]) => void; basket: ShopBasketView | null }) {
  const uid = useId();
  const [text, setText] = useState('');
  const problems = basket?.promotions.couponProblems ?? [];
  const add = () => {
    const code = text.trim().toUpperCase();
    if (code === '' || codes.includes(code) || codes.length >= 5) return;
    onCodes([...codes, code]);
    setText('');
  };
  return (
    <div className="space-y-2" role="group" aria-label="Promo code">
      <label htmlFor={`${uid}-promo`} className="flex items-center gap-1.5 text-sm font-medium text-fg"><Tag className="h-4 w-4" aria-hidden="true" />Promo code</label>
      <div className="flex gap-2">
        <input
          id={`${uid}-promo`}
          value={text}
          maxLength={40}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className={inputClass}
          placeholder="Enter a code"
        />
        <button type="button" onClick={add} disabled={text.trim() === '' || codes.length >= 5} className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-raised px-4 text-sm font-semibold text-fg-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50">Apply</button>
      </div>
      {codes.length === 0 ? null : (
        <ul aria-label="Codes used" className="flex flex-wrap gap-2">
          {codes.map((code) => (
            <li key={code} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised py-1 pr-1 pl-3 font-mono text-xs text-fg-strong">
              {code}
              <button type="button" aria-label={`Remove code ${code}`} onClick={() => onCodes(codes.filter((c) => c !== code))} className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full hover:bg-hover"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {problems.map((p) => (
        <p key={p.code} role="alert" className="text-sm text-red-700">{p.code}: {p.reason}</p>
      ))}
    </div>
  );
}
