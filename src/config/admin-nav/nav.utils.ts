import { ADMIN_NAV_MAX_DEPTH, type AdminNavActiveMatch, type AdminNavItem } from './types';
import { ADMIN_NAV } from './nav.config';

function isInstalled(item: AdminNavItem): boolean {
  return item.installed !== false;
}

/**
 * Normalize tree: drop uninstalled, clamp depth, fill safe defaults.
 * Fault-tolerant — bad nodes are skipped rather than crashing the sidebar.
 */
export function normalizeAdminNav(
  items: AdminNavItem[],
  depth = 1,
  seenIds = new Set<string>(),
): AdminNavItem[] {
  if (!Array.isArray(items) || depth > ADMIN_NAV_MAX_DEPTH) return [];

  const result: AdminNavItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isInstalled(raw)) continue;
    if (typeof raw.id !== 'string' || !raw.id.trim()) continue;
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue;
    if (typeof raw.name !== 'string' || !raw.name.trim()) continue;
    if (typeof raw.href !== 'string' || !raw.href.startsWith('/')) continue;
    if (seenIds.has(raw.id)) continue;

    seenIds.add(raw.id);

    const subLinks =
      depth < ADMIN_NAV_MAX_DEPTH && Array.isArray(raw.subLinks)
        ? normalizeAdminNav(raw.subLinks, depth + 1, seenIds)
        : undefined;

    result.push({
      ...raw,
      id: raw.id.trim(),
      title: raw.title.trim(),
      name: raw.name.trim(),
      href: raw.href.trim(),
      disabled: Boolean(raw.disabled),
      installed: true,
      subLinks: subLinks && subLinks.length > 0 ? subLinks : undefined,
    });
  }

  return result;
}

/** Canonical nav tree used by UI (always normalized). */
export function getAdminNav(): AdminNavItem[] {
  return normalizeAdminNav(ADMIN_NAV);
}

function pathScore(href: string, pathname: string): number {
  if (pathname === href) return href.length + 1000;
  // Prefer exact segment boundaries: /admin/products matches /admin/products/xyz
  if (href !== '/admin' && pathname.startsWith(`${href}/`)) return href.length;
  return -1;
}

/**
 * Longest-prefix match of pathname against the nav tree.
 * Returns active leaf + ancestor trail for highlighting / accordion.
 */
export function findActiveNavMatch(
  pathname: string,
  items: AdminNavItem[] = getAdminNav(),
): AdminNavActiveMatch | null {
  let best: AdminNavActiveMatch | null = null;
  let bestScore = -1;

  const walk = (nodes: AdminNavItem[], ancestors: AdminNavItem[]) => {
    for (const node of nodes) {
      const trail = [...ancestors, node];
      const score = pathScore(node.href, pathname);
      if (
        score > bestScore ||
        (score === bestScore && best !== null && trail.length > best.trail.length)
      ) {
        bestScore = score;
        best = {
          item: node,
          trail,
          trailIds: trail.map((t) => t.id),
        };
      }
      if (node.subLinks?.length) {
        walk(node.subLinks, trail);
      }
    }
  };

  walk(items, []);
  return best;
}

export function findNavItemById(
  id: string,
  items: AdminNavItem[] = getAdminNav(),
): AdminNavItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.subLinks?.length) {
      const found = findNavItemById(id, item.subLinks);
      if (found) return found;
    }
  }
  return null;
}

export function getNavItemChildren(item: AdminNavItem): AdminNavItem[] {
  return item.subLinks?.filter(isInstalled) ?? [];
}

export function hasSubLinks(item: AdminNavItem): boolean {
  return getNavItemChildren(item).length > 0;
}

/** Header title/subtitle for the current route. */
export function getAdminPageMeta(pathname: string): { title: string; subtitle: string } {
  const match = findActiveNavMatch(pathname);
  if (!match) {
    return { title: 'Admin', subtitle: 'Console' };
  }
  return {
    title: match.item.title,
    subtitle: match.item.description || match.trail.map((t) => t.title).join(' / '),
  };
}
