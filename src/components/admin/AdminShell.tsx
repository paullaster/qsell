'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, RefreshCw, Store } from 'lucide-react';
import { AdminSidebar } from './AdminSidebar';
import { useRealtimeEvents } from '@/lib/realtime';
import { ensureAdminSessionAction } from '@/server/domains/auth/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { getAdminPageMeta } from '@/config/admin-nav';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const uiConfig = useCompanyUiConfig();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [company, setCompany] = useState<Pick<
    CompanySettingsRow,
    'tradingName' | 'tagline' | 'logoUrl' | 'accentColor'
  > | null>(null);
  const [moduleLabels, setModuleLabels] = useState(uiConfig.moduleLabels);

  const pageMeta = useMemo(
    () => getAdminPageMeta(pathname, moduleLabels),
    [pathname, moduleLabels],
  );

  useEffect(() => {
    let cancelled = false;
    void ensureAdminSessionAction()
      .then(() => {
        if (!cancelled) setSessionReady(true);
      })
      .catch(() => {
        if (!cancelled) setSessionReady(true);
      });
    void getCompanySettingsAction()
      .then((row) => {
        if (!cancelled) {
          setCompany({
            tradingName: row.tradingName,
            tagline: row.tagline,
            logoUrl: row.logoUrl,
            accentColor: row.accentColor,
          });
          setModuleLabels(resolveCompanyUiConfig(row.uiConfig).moduleLabels);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onRefreshAll = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleRealtime = useCallback(() => {
    router.refresh();
  }, [router]);

  const { isConnected } = useRealtimeEvents(handleRealtime);

  if (!sessionReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-sm text-zinc-400">
        Preparing admin session…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-black text-zinc-300">
      <AdminSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        onRefreshAll={onRefreshAll}
        isRealtimeConnected={isConnected}
        company={company}
        moduleLabels={moduleLabels}
      />

      <div className="flex min-w-0 flex-1 flex-col lg:pl-72">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 lg:hidden"
            onClick={() => setIsMobileSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-white">{pageMeta.title}</h1>
            <p className="truncate text-[10px] tracking-wider text-zinc-500 uppercase">
              {pageMeta.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefreshAll}
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <Link
            href="/"
            className="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white sm:inline-flex"
          >
            <Store className="h-3.5 w-3.5" />
            Store
          </Link>
          <span
            className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-zinc-600'}`}
            title={isConnected ? 'Realtime connected' : 'Realtime offline'}
          />
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
