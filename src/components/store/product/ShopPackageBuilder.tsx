'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ShopPackage } from '@/server/domains/pricing/domain/package-shop';
import { allowsCart, allowsQuote } from '@/server/domains/pricing/domain/package-order-mode';
import { packageLine, type PackageCartLine } from '@/lib/package-cart';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { useToast } from '@/components/store/ToastProvider';
import { PackageBuilder } from '@/components/store/product/PackageBuilder';
import { PackageQuoteRequest, type QuoteChoice } from '@/components/store/product/PackageQuoteRequest';

/**
 * The shared builder wired to the shopper's cart: Add to cart and Buy now, or Save changes when a cart line is being edited. Where the
 * company sells the package by quote (set per package), Request a quote stands beside Add to cart, or instead of it.
 */
export function ShopPackageBuilder({ productName, builder, editing, onDone }: { productName: string; builder: { package: ShopPackage; available: string[] }; editing?: PackageCartLine; onDone?: () => void }) {
  const { money } = useStore();
  const cart = useCart();
  const toast = useToast();
  const router = useRouter();
  const [asking, setAsking] = useState<QuoteChoice | null>(null);
  const mode = builder.package.orderMode;
  // Editing a cart line is always the cart; a quote is asked for only from a fresh builder.
  const offerQuote = editing === undefined && allowsQuote(mode);
  const quoteOnly = !allowsCart(mode);
  return (
    <div className="space-y-4">
      <PackageBuilder
        productName={productName}
        builder={builder}
        money={money}
        {...(editing === undefined && !quoteOnly ? { buyLabel: 'Buy now' } : {})}
        {...(editing === undefined ? {} : { initial: { picks: editing.picks, servings: editing.servings, note: editing.note } })}
        {...(offerQuote ? { quoteLabel: 'Request a quote' } : {})}
        quoteOnly={quoteOnly && editing === undefined}
        submitLabel={editing === undefined ? 'Add to cart' : 'Save changes'}
        onSubmit={async (picks, servings, intent, note) => {
          if (intent === 'quote') {
            setAsking({ picks, servings, note });
            return null;
          }
          const line = packageLine(builder.package.productId, picks, servings, note);
          const answer = editing === undefined ? await cart.addPackage(line) : await cart.editPackage(editing.id, line);
          if (!answer.ok) return answer.problems[0] ?? 'This choice cannot be ordered.';
          toast({ type: 'success', title: editing === undefined ? 'Added to your cart' : 'Changes saved', message: answer.summary });
          if (onDone !== undefined) onDone();
          else if (intent === 'buy') router.push('/checkout');
          return null;
        }}
      />
      {asking === null ? null : <PackageQuoteRequest productId={builder.package.productId} choice={asking} onCancel={() => setAsking(null)} />}
    </div>
  );
}
