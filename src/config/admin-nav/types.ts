/**
 * Central admin navigation types.
 * Single source of truth for sidebar structure (max depth 5).
 */

export const ADMIN_NAV_MAX_DEPTH = 5;

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
  | 'Settings'
  | 'GitBranch'
  | 'Receipt'
  | 'BookOpen'
  | 'Scale'
  | 'KeyRound'
  | 'UserCog'
  | 'Fingerprint'
  | 'Activity';

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
  /** When true, item is visible but not navigable */
  disabled?: boolean;
  /** When false, item is omitted from the rendered nav */
  installed?: boolean;
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
