/**
 * Central admin navigation types.
 * Single source of truth for sidebar structure (max depth 5).
 */

import type { PermissionKey } from '@/server/domains/access-control/permissions';

export const ADMIN_NAV_MAX_DEPTH = 5;

/** What the signed-in user may do; decides which nav items they are shown. */
export interface AdminNavAccess {
  superAdmin: boolean;
  permissions: readonly PermissionKey[];
}

export type AdminNavIconName =
  | 'LayoutDashboard'
  | 'Package'
  | 'FolderTree'
  | 'Layers'
  | 'CreditCard'
  | 'ShieldCheck'
  | 'ShoppingBag'
  | 'Users'
  | 'Percent'
  | 'Coins'
  | 'Building2'
  | 'Store'
  | 'Wallet'
  | 'Boxes'
  | 'Palette'
  | 'LayoutGrid'
  | 'Tags'
  | 'Shapes'
  | 'Trash2'
  | 'Settings'
  | 'GitBranch'
  | 'Receipt'
  | 'BookOpen'
  | 'Scale'
  | 'KeyRound'
  | 'UserCog'
  | 'Fingerprint'
  | 'LifeBuoy'
  | 'Activity'
  | 'FolderKanban'
  | 'ClipboardCheck'
  | 'Landmark'
  | 'CalendarClock'
  | 'FileCheck';

export interface AdminNavItem {
  /** Stable unique id across the whole tree */
  id: string;
  /** Human-readable label shown in the sidebar */
  title: string;
  /** Machine name / route key (unique among siblings) */
  name: string;
  /** Absolute admin path for this item's index screen */
  href: string;
  /** Optional short description for hub pages / header */
  description?: string;
  /** Lucide icon key resolved at render time */
  icon?: AdminNavIconName;
  /**
   * Switches the item off. Defaults to false. A disabled item is never shown
   * to anyone, and neither is anything beneath it.
   */
  disabled?: boolean;
  /**
   * The user needs at least one of these to see the item. Leave it off a
   * section that has sub links: it then shows only when one of them does.
   * A screen with no permission is never shown.
   */
  permission?: PermissionKey | readonly PermissionKey[];
  /** Nested navigation (depth capped at ADMIN_NAV_MAX_DEPTH) */
  subLinks?: AdminNavItem[];
}

export interface AdminNavActiveMatch {
  /** Leaf (or deepest) item matching the current pathname */
  item: AdminNavItem;
  /** Root → leaf ids inclusive */
  trailIds: string[];
  /** Root → leaf items inclusive */
  trail: AdminNavItem[];
}
