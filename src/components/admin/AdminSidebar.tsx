'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { RefreshCw, Store, X } from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { AdminNavTree } from '@/components/admin/nav/AdminNavTree';
import {
  findActiveNavMatch,
  getAdminNav,
  hasSubLinks,
  type AdminNavItem,
} from '@/config/admin-nav';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

interface AdminSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onRefreshAll: () => void;
  isRealtimeConnected: boolean;
  company?: Pick<CompanySettingsRow, 'tradingName' | 'tagline' | 'logoUrl' | 'accentColor'> | null;
  moduleLabels?: Record<string, string> | null;
}

/** Branch nodes on the active route — these stay open after a refresh. */
function openIdsFromTrail(trail: AdminNavItem[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const node of trail ?? []) {
    if (hasSubLinks(node)) ids.add(node.id);
  }
  return ids;
}

function collectBranchIds(item: AdminNavItem, into: Set<string>) {
  into.add(item.id);
  for (const child of item.subLinks ?? []) collectBranchIds(child, into);
}

export function AdminSidebar({
  isOpen,
  onClose,
  onRefreshAll,
  isRealtimeConnected,
  company,
  moduleLabels,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = useMemo(() => getAdminNav(moduleLabels), [moduleLabels]);

  const match = useMemo(() => findActiveNavMatch(pathname, nav), [pathname, nav]);
  const trailIds = useMemo(() => new Set(match?.trailIds ?? []), [match]);
  const activeId = match?.item.id ?? null;
  const trailKey = match?.trailIds.join('/') ?? '';

  const [openIds, setOpenIds] = useState<Set<string>>(() => openIdsFromTrail(match?.trail));

  // A refresh or a real navigation reopens the branch that owns this URL.
  // Collapsing the same branch does not change the path, so it stays closed.
  useEffect(() => {
    setOpenIds(openIdsFromTrail(match?.trail));
  }, [trailKey, match]);

  const toggleBranch = (item: AdminNavItem, open: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(item.id);
        // Re-opening the branch that owns this URL shows its nested trail again.
        const trail = match?.trail ?? [];
        const index = trail.findIndex((node) => node.id === item.id);
        if (index >= 0) {
          for (const node of trail.slice(index)) {
            if (hasSubLinks(node)) next.add(node.id);
          }
        }
        return next;
      }
      const drop = new Set<string>();
      collectBranchIds(item, drop);
      for (const id of drop) next.delete(id);
      return next;
    });
  };

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-backdrop/80 backdrop-blur-sm transition-opacity lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 transform flex-col border-r border-line bg-surface transition-transform duration-200 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-line px-5">
          <Link href="/admin" className="flex items-center gap-2.5" onClick={onClose}>
            <CompanyBrand
              tradingName={company?.tradingName || 'Admin'}
              tagline={company?.tagline}
              logoUrl={company?.logoUrl}
              accentColor={company?.accentColor}
              size="sm"
              subtitle="Admin Console"
            />
          </Link>
          <button type="button" className="text-fg-muted lg:hidden" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Admin">
          <AdminNavTree
            items={nav}
            trailIds={trailIds}
            activeId={activeId}
            openIds={openIds}
            onToggle={toggleBranch}
            onNavigate={onClose}
          />
        </nav>

        <div className="space-y-2 border-t border-line p-3">
          <button
            type="button"
            onClick={() => {
              onRefreshAll();
              router.refresh();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-hover hover:text-fg-strong"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh data
            <span
              className={`ml-auto h-2 w-2 rounded-full ${
                isRealtimeConnected ? 'bg-emerald-500' : 'bg-fg-faint'
              }`}
            />
          </button>
          <Link
            href="/"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-hover hover:text-fg-strong"
          >
            <Store className="h-4 w-4" />
            Back to storefront
          </Link>
        </div>
      </aside>
    </>
  );
}
