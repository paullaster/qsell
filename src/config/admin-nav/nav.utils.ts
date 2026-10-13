import {
  ADMIN_NAV_MAX_DEPTH,
  type AdminNavAccess,
  type AdminNavActiveMatch,
  type AdminNavItem,
} from './types';
import { ADMIN_NAV } from './nav.config';
import { applyModuleLabels } from '@/config/company-ui';

function isEnabled(item: AdminNavItem): boolean {
  return item.disabled !== true;
}

function holds(access: AdminNavAccess, permission: AdminNavItem['permission']): boolean {
  if (permission === undefined) return false;
  if (access.superAdmin) return true;
  const needed = typeof permission === 'string' ? [permission] : permission;
  return needed.some((key) => access.permissions.includes(key));
}

/**
 * Keep only what this user may open. Fails closed: a screen with no permission
 * is hidden, and a section is hidden when none of its sub links remain.
 */
export function filterAdminNavByAccess(
  items: AdminNavItem[],
  access: AdminNavAccess | null,
): AdminNavItem[] {
  const allowed: AdminNavAccess = access ?? { superAdmin: false, permissions: [] };
  const result: AdminNavItem[] = [];
  for (const item of items) {
    const isSection = (item.subLinks?.length ?? 0) > 0;
    if (item.permission !== undefined && !holds(allowed, item.permission)) continue;
    if (isSection) {
      const subLinks = filterAdminNavByAccess(item.subLinks ?? [], allowed);
      if (subLinks.length === 0) continue;
      result.push({ ...item, subLinks });
    } else {
      if (!holds(allowed, item.permission)) continue;
      result.push(item);
    }
  }
  return result;
}

/**
 * Normalize tree: drop disabled, clamp depth, fill safe defaults.
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
    if (typeof raw !== 'object') continue;
    if (!isEnabled(raw)) continue;
    if (typeof raw.id !== 'string' || raw.id.trim() === '') continue;
    if (typeof raw.title !== 'string' || raw.title.trim() === '') continue;
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
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
      disabled: false,
      subLinks: subLinks && subLinks.length > 0 ? subLinks : undefined,
    });
  }

  return result;
}

/** Canonical nav tree used by UI (always normalized). */
export function getAdminNav(
  moduleLabels?: Record<string, string> | null,
  access?: AdminNavAccess | null,
): AdminNavItem[] {
  const normalized = normalizeAdminNav(ADMIN_NAV);
  // Omit `access` only for structure checks; every screen a user sees passes it.
  const base = access === undefined ? normalized : filterAdminNavByAccess(normalized, access);
  if (!moduleLabels || Object.keys(moduleLabels).length === 0) return base;
  return applyModuleLabels(base, moduleLabels);
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
      if (node.subLinks && node.subLinks.length > 0) {
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
    if (item.subLinks && item.subLinks.length > 0) {
      const found = findNavItemById(id, item.subLinks);
      if (found) return found;
    }
  }
  return null;
}

export function getNavItemChildren(item: AdminNavItem): AdminNavItem[] {
  return item.subLinks?.filter(isEnabled) ?? [];
}

export function hasSubLinks(item: AdminNavItem): boolean {
  return getNavItemChildren(item).length > 0;
}

/** Header title/subtitle for the current route. */
export function getAdminPageMeta(
  pathname: string,
  moduleLabels?: Record<string, string> | null,
): { title: string; subtitle: string } {
  const match = findActiveNavMatch(pathname, getAdminNav(moduleLabels));
  if (!match) {
    return { title: 'Admin', subtitle: 'Console' };
  }
  return {
    title: match.item.title,
    subtitle: match.item.description ?? match.trail.map((t) => t.title).join(' / '),
  };
}
