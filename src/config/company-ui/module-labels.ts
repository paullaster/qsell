import type { AdminNavItem } from '@/config/admin-nav/types';

/**
 * Apply company module label overrides onto a normalized nav tree.
 * Unknown ids are ignored; empty overrides keep the built-in title.
 * Pure + immutable — never mutates the input tree.
 */
export function applyModuleLabels(
  items: AdminNavItem[],
  labels: Record<string, string> | null | undefined,
): AdminNavItem[] {
  if (!labels || Object.keys(labels).length === 0) return items;

  return items.map((item) => {
    const override = labels[item.id];
    const title =
      typeof override === 'string' && override.trim() ? override.trim() : item.title;
    const subLinks = item.subLinks?.length
      ? applyModuleLabels(item.subLinks, labels)
      : item.subLinks;
    if (title === item.title && subLinks === item.subLinks) return item;
    return { ...item, title, subLinks };
  });
}

/** Flat list of labelable modules for the Company Setup UI. */
export type ModuleLabelOption = {
  id: string;
  defaultTitle: string;
  depth: number;
  href: string;
};

export function flattenModuleLabelOptions(
  items: AdminNavItem[],
  depth = 0,
): ModuleLabelOption[] {
  const out: ModuleLabelOption[] = [];
  for (const item of items) {
    out.push({
      id: item.id,
      defaultTitle: item.title,
      depth,
      href: item.href,
    });
    if (item.subLinks?.length) {
      out.push(...flattenModuleLabelOptions(item.subLinks, depth + 1));
    }
  }
  return out;
}
