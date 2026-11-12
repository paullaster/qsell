'use client';

import { useEffect, useState } from 'react';
import { quotePackageBuilderAction } from '@/server/domains/quotes/actions';
import { resolveStoredPicksLenient, storedPicks, wordsList, type ShopPackage, type StoredPick } from '@/server/domains/pricing/domain/package-shop';
import { PackageBuilder } from '@/components/store/product/PackageBuilder';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';

interface Loaded {
  package: ShopPackage;
  available: string[];
}

export interface ChosenPackage {
  productId: string;
  servings: number;
  picks: StoredPick[];
  summary: string;
}

/**
 * Choosing a package for a quote with the same builder the shop uses. A new line starts from a package picked here; an existing line
 * reopens on its kept choices (a choice the package no longer offers is left empty, so a replacement can be picked).
 */
export function QuotePackageDialog({ money, editing, onClose, onChosen }: { money: (amount: number) => string; editing?: { productId: string; servings: number; picks: StoredPick[] }; onClose: () => void; onChosen: (chosen: ChosenPackage) => void }) {
  const [product, setProduct] = useState<Choice | null>(null);
  const productId = editing?.productId ?? product?.id ?? null;
  const [loaded, setLoaded] = useState<{ id: string; result: Loaded | 'missing' | 'failed' } | null>(null);

  useEffect(() => {
    if (productId === null) return;
    let live = true;
    void quotePackageBuilderAction(productId)
      .then((r) => {
        if (live) setLoaded({ id: productId, result: r.ok ? (r.data ?? 'missing') : 'failed' });
      })
      .catch(() => {
        if (live) setLoaded({ id: productId, result: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [productId]);

  const ready = productId !== null && loaded !== null && loaded.id === productId ? loaded.result : null;
  const pkg = ready !== null && ready !== 'missing' && ready !== 'failed' ? ready : null;
  // Parts the package no longer offers are left out, so the person sees what is missing and chooses again.
  const kept = editing === undefined || pkg === null ? null : resolveStoredPicksLenient(pkg.package, editing.picks);
  const initial = editing === undefined || kept === null ? undefined : { picks: kept.picks, servings: editing.servings };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-backdrop/70 p-0 sm:items-center sm:p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Choose a package" className="max-h-dvh w-full max-w-xl space-y-4 overflow-y-auto rounded-t-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-fg-strong">{editing === undefined ? 'Add a package' : 'Change the choices'}</h2>
          <button type="button" onClick={onClose} className="min-h-10 cursor-pointer rounded-lg px-3 text-sm font-medium text-fg-muted hover:bg-hover">Close</button>
        </div>
        {editing === undefined ? <ChoicePicker label="Package" source="quote-packages" choice={product} onChoice={setProduct} placeholder="Search packages…" /> : null}
        {productId !== null && ready === null ? <p role="status" className="text-sm text-fg-muted">Opening the package…</p> : null}
        {ready === 'missing' ? <p role="alert" className="text-sm text-red-400">That product is not a package any more.</p> : null}
        {ready === 'failed' ? <p role="alert" className="text-sm text-red-400">The package could not be opened. Please try again.</p> : null}
        {kept !== null && kept.missing.length > 0 ? <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">The package no longer offers: {kept.missing.join(', ')}. Choose a replacement.</p> : null}
        {pkg !== null ? (
          <PackageBuilder
            key={pkg.package.productId}
            productName={pkg.package.name}
            builder={pkg}
            money={money}
            watchStock={false}
            servingsLabel="Servings"
            submitLabel={editing === undefined ? 'Add to the quote' : 'Save choices'}
            {...(initial === undefined ? {} : { initial })}
            onSubmit={(picks, servings) => {
              const kept = storedPicks(pkg.package, picks);
              // The line reads as the choices, as the server will write it.
              const summary = `${pkg.package.name}: ${wordsList(kept.map((p) => (p.count > 1 ? `${String(p.count)} × ${p.name}` : p.name)))}`;
              onChosen({ productId: pkg.package.productId, servings, picks: kept, summary });
              return Promise.resolve(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
