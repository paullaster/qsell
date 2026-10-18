'use client';

import Link from 'next/link';
import {
  LayoutDashboard,
  Package,
  FolderTree,
  Layers,
  CreditCard,
  ShieldCheck,
  ShoppingBag,
  Users,
  Percent,
  Coins,
  Building2,
  Store,
  Wallet,
  Boxes,
  Palette,
  LayoutGrid,
  Tags,
  Shapes,
  Trash2,
  Settings,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Receipt,
  BookOpen,
  Scale,
  KeyRound,
  UserCog,
  Fingerprint,
  LifeBuoy,
  Activity,
  FolderKanban,
  type LucideIcon,
} from 'lucide-react';
import { hasSubLinks, type AdminNavIconName, type AdminNavItem } from '@/config/admin-nav';

const ICONS: Record<AdminNavIconName, LucideIcon> = {
  LayoutDashboard,
  Package,
  FolderTree,
  Layers,
  CreditCard,
  ShieldCheck,
  ShoppingBag,
  Users,
  Percent,
  Coins,
  Building2,
  Store,
  Wallet,
  Boxes,
  Palette,
  LayoutGrid,
  Tags,
  Shapes,
  Trash2,
  Settings,
  GitBranch,
  Receipt,
  BookOpen,
  Scale,
  KeyRound,
  UserCog,
  Fingerprint,
  LifeBuoy,
  Activity,
  FolderKanban,
};

function NavIcon({ name }: { name?: AdminNavIconName }) {
  if (name === undefined) return null;
  const Icon = ICONS[name];
  return <Icon className="h-4 w-4 shrink-0" />;
}

interface AdminNavTreeProps {
  items: AdminNavItem[];
  depth?: number;
  trailIds: ReadonlySet<string>;
  activeId: string | null;
  /** Branch nodes whose children are visible. */
  openIds: ReadonlySet<string>;
  onToggle: (item: AdminNavItem, open: boolean) => void;
  onNavigate: () => void;
}

export function AdminNavTree({
  items,
  depth = 1,
  trailIds,
  activeId,
  openIds,
  onToggle,
  onNavigate,
}: AdminNavTreeProps) {
  return (
    <ul
      className={depth === 1 ? 'space-y-0.5' : 'mt-0.5 ml-3 space-y-0.5 border-l border-line pl-2'}
    >
      {items.map((item) => {
        const nested = hasSubLinks(item);
        const isActive = activeId === item.id;
        const inTrail = trailIds.has(item.id);
        const isOpen = nested && openIds.has(item.id);

        let stateClass: string;
        if (isActive) {
          stateClass = 'bg-indigo-600 text-white';
        } else if (inTrail) {
          stateClass = 'bg-surface-sunken text-indigo-400';
        } else {
          stateClass = 'text-fg-muted hover:bg-hover hover:text-fg-strong';
        }

        const ChevronIcon = nested ? ChevronDown : ChevronRight;
        const chevron = nested ? (
          <ChevronIcon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        ) : null;

        return (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              aria-expanded={nested ? isOpen : undefined}
              onClick={(e) => {
                if (nested) {
                  if (isOpen) {
                    e.preventDefault();
                    onToggle(item, false);
                    return;
                  }
                  onToggle(item, true);
                  if (inTrail) e.preventDefault();
                }
                onNavigate();
              }}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${stateClass}`}
            >
              <NavIcon name={item.icon} />
              <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
              {chevron}
            </Link>

            {isOpen && item.subLinks ? (
              <AdminNavTree
                items={item.subLinks}
                depth={depth + 1}
                trailIds={trailIds}
                activeId={activeId}
                openIds={openIds}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
