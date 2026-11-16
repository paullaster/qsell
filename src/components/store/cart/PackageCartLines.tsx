'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { packageBuilderAction } from '@/server/domains/pricing/package-shop-actions';
import type { ShopBuilder } from '@/server/domains/pricing/package-shop-service';
import { MAX_SERVINGS, type PackageCartLine } from '@/lib/package-cart';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { ShopPackageBuilder } from '@/components/store/product/ShopPackageBuilder';
import { productHref } from '@/lib/product-link';

/** The sum of the lines the shop has accepted (a line it refuses has no price to add). */
export function packagesTotal(lines: readonly PackageCartLine[], checks: ReturnType<typeof useCart>['packageChecks']): number {
  const sum = lines.reduce((n, l) => {
    const check = checks[l.id];
    return check?.ok === true ? n + check.total : n;
  }, 0);
  return Math.round(sum * 100) / 100;
}

/** The configured packages in the cart: what was chosen in words, the price the shop works out, servings, Edit and Remove. */
export function PackageCartLines({ onNavigate }: { onNavigate?: () => void }) {
  const { packages, packageChecks, setPackageServings, removePackage } = useCart();
  const { money } = useStore();
  const [editing, setEditing] = useState<{ id: string; builder: ShopBuilder } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (packages.length === 0) return null;

  const edit = async (line: PackageCartLine) => {
    setLoading(line.id);
    setFailed(null);
    try {
      const result = await packageBuilderAction(line.productId, line.servings);
      if (result.ok && result.data !== null) setEditing({ id: line.id, builder: result.data });
      else setFailed('This package cannot be changed right now.');
    } catch {
      setFailed('The shop could not be reached. Please try again.');
    } finally {
      setLoading(null);
    }
  };

  return (
    <ul className="space-y-4" aria-label="Packages in your cart">
      {packages.map((line) => {
        const check = packageChecks[line.id];
        const open = editing?.id === line.id ? editing : null;
        return (
          <li key={line.id} data-testid="package-line" className="space-y-3 rounded-lg border border-line bg-surface p-3.5">
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-semibold text-fg-strong">
                {check?.ok === true ? check.summary : <Link href={productHref({ id: line.productId })} onClick={onNavigate} className="hover:underline">A package you chose</Link>}
              </h3>
              {line.note === '' ? null : <p className="text-xs text-fg-muted" data-testid="package-line-note">Note: {line.note}</p>}
              {check === undefined ? <p className="text-xs text-fg-muted" role="status">Checking price and stock…</p> : null}
              {check?.ok === true ? (
                <p className="font-mono text-sm font-bold text-fg-strong">
                  {money(check.total)}
                  <span className="font-normal text-fg-subtle"> @ {money(check.servingPrice)} each</span>
                </p>
              ) : null}
              {check?.ok === false ? <p role="alert" className="text-sm text-red-400">{check.problems.join(' ')}</p> : null}
            </div>
            {open !== null ? (
              <div className="border-t border-line pt-3">
                <ShopPackageBuilder productName={open.builder.package.name} builder={open.builder} editing={line} onDone={() => setEditing(null)} />
                <button type="button" onClick={() => setEditing(null)} className="mt-2 min-h-10 cursor-pointer text-sm font-medium text-fg-muted hover:underline">Cancel</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1">
                  <button type="button" aria-label="One less serving" disabled={line.servings <= 1} onClick={() => setPackageServings(line.id, line.servings - 1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><Minus className="h-4 w-4" aria-hidden="true" /></button>
                  <span className="w-10 text-center text-sm font-semibold" aria-label={`${String(line.servings)} servings`}>{line.servings}</span>
                  <button type="button" aria-label="One more serving" disabled={line.servings >= MAX_SERVINGS} onClick={() => setPackageServings(line.id, line.servings + 1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" /></button>
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" onClick={() => void edit(line)} disabled={loading === line.id} className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-indigo-400 hover:bg-hover disabled:opacity-50">
                    <Pencil className="h-4 w-4" aria-hidden="true" />Edit
                  </button>
                  <button type="button" onClick={() => removePackage(line.id)} title="Remove item" aria-label="Remove this package" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-fg-subtle transition-colors hover:text-red-600 focus-visible:outline-2 focus-visible:outline-indigo-500">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </span>
              </div>
            )}
          </li>
        );
      })}
      {failed === null ? null : <li role="alert" className="text-sm text-red-400">{failed}</li>}
    </ul>
  );
}
