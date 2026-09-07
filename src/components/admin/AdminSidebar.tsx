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
  company?: Pick<
    CompanySettingsRow,
    'tradingName' | 'tagline' | 'logoUrl' | 'accentColor'
  > | null;
  moduleLabels?: Record<string, string> | null;
}

/** Deepest node on the active trail that owns children — keeps accordion in sync with the URL. */
function resolveExpandedFromTrail(trail: AdminNavItem[]): string | null {
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const node = trail[i];
    if (node && hasSubLinks(node)) return node.id;
  }
  return null;
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

  const [expandedId, setExpandedId] = useState<string | null>(() =>
    match ? resolveExpandedFromTrail(match.trail) : null,
  );

  // Keep a single open branch aligned with the current route.
  useEffect(() => {
    if (!match) {
      setExpandedId(null);
      return;
    }
    setExpandedId(resolveExpandedFromTrail(match.trail));
  }, [match]);

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm transition-opacity lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 transform flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-zinc-800 px-5">
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
          <button type="button" className="text-zinc-400 lg:hidden" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Admin">
          <AdminNavTree
            items={nav}
            trailIds={trailIds}
            activeId={activeId}
            expandedId={expandedId}
            onExpand={setExpandedId}
            onNavigate={onClose}
          />
        </nav>

        <div className="space-y-2 border-t border-zinc-800 p-3">
          <button
            type="button"
            onClick={() => {
              onRefreshAll();
              router.refresh();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh data
            <span
              className={`ml-auto h-2 w-2 rounded-full ${
                isRealtimeConnected ? 'bg-emerald-500' : 'bg-zinc-600'
              }`}
            />
          </button>
          <Link
            href="/"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <Store className="h-4 w-4" />
            Back to storefront
          </Link>
        </div>
      </aside>
    </>
  );
}
