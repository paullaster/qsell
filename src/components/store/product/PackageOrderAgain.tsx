'use client';

import { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { packageOrderAgainAction } from '@/server/domains/pricing/package-shop-actions';
import type { OrderAgainOption } from '@/server/domains/pricing/package-shop-service';
import { packageLine } from '@/lib/package-cart';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { useToast } from '@/components/store/ToastProvider';

/**
 * For a signed-in shopper: what they ordered of this package before, one tap to put it in the cart again. The server found each earlier
 * choice again against today's package and stock; a part that is sold out is swapped for the nearest one available, and that is said.
 */
export function PackageOrderAgain({ productId }: { productId: string }) {
  const { sessionName, money } = useStore();
  const cart = useCart();
  const toast = useToast();
  const [options, setOptions] = useState<OrderAgainOption[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (sessionName === null) return;
    let live = true;
    void packageOrderAgainAction(productId)
      .then((r) => {
        if (live && r.ok) setOptions(r.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [productId, sessionName]);

  if (sessionName === null || options.length === 0) return null;

  const again = async (index: number, option: OrderAgainOption) => {
    setBusy(index);
    setProblem(null);
    const answer = await cart.addPackage(packageLine(productId, option.picks, option.servings, option.note));
    setBusy(null);
    if (!answer.ok) setProblem(answer.problems[0] ?? 'This could not be added.');
    else toast({ type: 'success', title: 'Added to your cart', message: answer.summary });
  };

  return (
    <section aria-labelledby={`again-${productId}`} className="space-y-2 rounded-xl border border-line bg-surface p-4" data-testid="order-again">
      <h3 id={`again-${productId}`} className="flex items-center gap-2 text-sm font-semibold text-fg-strong"><Repeat className="h-4 w-4 text-indigo-400" aria-hidden="true" />Order again</h3>
      <ul className="space-y-2">
        {options.map((option, index) => (
          <li key={`${option.summary}-${String(option.servings)}-${option.note}`} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="order-again-option">
            <div className="min-w-0">
              <p className="font-medium break-words text-fg-strong">{option.servings} × {option.summary.includes(': ') ? option.summary.slice(option.summary.indexOf(': ') + 2) : option.summary}</p>
              {option.replaced.map((r) => <p key={r.was} className="text-xs text-amber-700 dark:text-amber-300">{r.now} instead of {r.was}, which is sold out today.</p>)}
              {option.note === '' ? null : <p className="text-xs text-fg-muted">Note: {option.note}</p>}
              <p className="text-xs text-fg-muted">{money(option.total)}</p>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => void again(index, option)} className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 text-sm font-semibold text-fg-strong hover:bg-hover disabled:opacity-50">Add again</button>
          </li>
        ))}
      </ul>
      {problem === null ? null : <p role="alert" className="text-sm text-red-400">{problem}</p>}
    </section>
  );
}
