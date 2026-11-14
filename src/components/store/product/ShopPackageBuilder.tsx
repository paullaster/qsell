'use client';

import { useRouter } from 'next/navigation';
import type { ShopPackage } from '@/server/domains/pricing/domain/package-shop';
import { packageLine, type PackageCartLine } from '@/lib/package-cart';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { useToast } from '@/components/store/ToastProvider';
import { PackageBuilder } from '@/components/store/product/PackageBuilder';

/** The shared builder wired to the shopper's cart: Add to cart and Buy now, or Save changes when a cart line is being edited. */
export function ShopPackageBuilder({ productName, builder, editing, onDone }: { productName: string; builder: { package: ShopPackage; available: string[] }; editing?: PackageCartLine; onDone?: () => void }) {
  const { money } = useStore();
  const cart = useCart();
  const toast = useToast();
  const router = useRouter();
  return (
    <PackageBuilder
      productName={productName}
      builder={builder}
      money={money}
      {...(editing === undefined ? { buyLabel: 'Buy now' } : { initial: { picks: editing.picks, servings: editing.servings, note: editing.note } })}
      submitLabel={editing === undefined ? 'Add to cart' : 'Save changes'}
      onSubmit={async (picks, servings, intent, note) => {
        const line = packageLine(builder.package.productId, picks, servings, note);
        const answer = editing === undefined ? await cart.addPackage(line) : await cart.editPackage(editing.id, line);
        if (!answer.ok) return answer.problems[0] ?? 'This choice cannot be ordered.';
        toast({ type: 'success', title: editing === undefined ? 'Added to your cart' : 'Changes saved', message: answer.summary });
        if (onDone !== undefined) onDone();
        else if (intent === 'buy') router.push('/checkout');
        return null;
      }}
    />
  );
}
