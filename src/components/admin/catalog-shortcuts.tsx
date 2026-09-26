'use client';

import { useRouter } from 'next/navigation';
import type { Category, ItemType, TaxCategory } from '@/types/index';

export const CATALOG_SHORTCUT_CREATED = 'qsell:catalog-shortcut-created';

export type CatalogShortcutDetail =
  | { kind: 'category'; category: Category }
  | { kind: 'itemType'; itemType: ItemType }
  | { kind: 'tax'; tax: TaxCategory };

export function publishCatalogShortcut(detail: CatalogShortcutDetail) {
  window.dispatchEvent(
    new CustomEvent<CatalogShortcutDetail>(CATALOG_SHORTCUT_CREATED, { detail }),
  );
}

export function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values());
}

/** Text shortcut that soft-navigates so an intercepting route can open over the current screen. */
export function CatalogCreateShortcut({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="cursor-pointer text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 underline decoration-indigo-400/50 underline-offset-2 hover:text-indigo-500 dark:hover:text-indigo-300"
    >
      {children}
    </button>
  );
}
