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
  Settings,
  GitBranch,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import type { AdminNavIconName, AdminNavItem } from '@/config/admin-nav';
import { hasSubLinks } from '@/config/admin-nav';

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
  Settings,
  GitBranch,
};

function NavIcon({ name }: { name?: AdminNavIconName }) {
  if (!name) return null;
  const Icon = ICONS[name];
  if (!Icon) return null;
  return <Icon className="h-4 w-4 shrink-0" />;
}

/** True when `candidateId` is this node or nested under it. */
function containsId(item: AdminNavItem, candidateId: string): boolean {
  if (item.id === candidateId) return true;
  return (item.subLinks ?? []).some((child) => containsId(child, candidateId));
}

interface AdminNavTreeProps {
  items: AdminNavItem[];
  depth?: number;
  trailIds: ReadonlySet<string>;
  activeId: string | null;
  /** Single node whose branch is open (ancestors auto-reveal to reach it). */
  expandedId: string | null;
  onExpand: (id: string) => void;
  onNavigate: () => void;
}

export function AdminNavTree({
  items,
  depth = 1,
  trailIds,
  activeId,
  expandedId,
  onExpand,
  onNavigate,
}: AdminNavTreeProps) {
  return (
    <ul
      className={
        depth === 1
          ? 'space-y-0.5'
          : 'mt-0.5 ml-3 space-y-0.5 border-l border-zinc-800 pl-2'
      }
    >
      {items.map((item) => {
        const nested = hasSubLinks(item);
        const isActive = activeId === item.id;
        const inTrail = trailIds.has(item.id);
        const reveal =
          nested && expandedId !== null && containsId(item, expandedId);

        const stateClass = item.disabled
          ? 'cursor-not-allowed text-zinc-600 opacity-50'
          : isActive
            ? 'bg-indigo-600/20 text-indigo-200'
            : inTrail
              ? 'bg-zinc-900/70 text-indigo-300/90'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200';

        return (
          <li key={item.id}>
            <Link
              href={item.disabled ? '#' : item.href}
              aria-disabled={item.disabled || undefined}
              aria-current={isActive ? 'page' : undefined}
              aria-expanded={nested ? reveal : undefined}
              onClick={(e) => {
                if (item.disabled) {
                  e.preventDefault();
                  return;
                }
                if (nested) {
                  onExpand(item.id);
                }
                onNavigate();
              }}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${stateClass}`}
            >
              <NavIcon name={item.icon} />
              <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
              {nested ? (
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 opacity-70 transition-transform ${
                    reveal ? 'rotate-0' : '-rotate-90'
                  }`}
                />
              ) : null}
            </Link>

            {reveal && item.subLinks ? (
              <AdminNavTree
                items={item.subLinks}
                depth={depth + 1}
                trailIds={trailIds}
                activeId={activeId}
                expandedId={expandedId}
                onExpand={onExpand}
                onNavigate={onNavigate}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
