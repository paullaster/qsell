import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { productEditHref } from '@/lib/product-edit-link';

/**
 * A shortcut from a document line to the product's edit window (an intercepted route, so the document stays open underneath).
 * Shown only to people who may update products: `canEdit` comes from the server. The document itself is not changed by what
 * is saved here unless it is still a draft that reads the product again.
 */
export function ProductEditLink({ productId, name, canEdit, className = '' }: { productId: string | null; name: string; canEdit: boolean; className?: string }) {
  if (!canEdit || productId === null || productId === '') return null;
  return (
    <Link
      href={productEditHref(productId)}
      scroll={false}
      title="Edit this product"
      aria-label={`Edit product ${name}`}
      className={`inline-flex min-h-10 min-w-10 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-surface-sunken print:hidden ${className}`}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Edit product</span>
    </Link>
  );
}
