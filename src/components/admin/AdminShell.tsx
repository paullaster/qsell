'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, RefreshCw, Store, LogOut, User, ChevronDown, Settings } from 'lucide-react';
import { AdminSidebar } from './AdminSidebar';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useRealtimeEvents } from '@/lib/realtime';
import { ensureAdminSessionAction } from '@/server/domains/auth/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { getAdminPageMeta } from '@/config/admin-nav';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { logoutAction } from '@/server/domains/auth/actions';
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
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

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

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-user-menu]')) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!sessionReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-fg-muted">
        Preparing admin session…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-canvas text-fg">
      <AdminSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        onRefreshAll={onRefreshAll}
        isRealtimeConnected={isConnected}
        company={company}
        moduleLabels={moduleLabels}
      />

      <div className="flex min-w-0 flex-1 flex-col lg:pl-72">
        <header
          className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur-md sm:px-6"
          data-user-menu
        >
          <button
            type="button"
            className="rounded-lg p-2 text-fg-muted hover:bg-hover lg:hidden"
            onClick={() => setIsMobileSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-fg-strong">{pageMeta.title}</h1>
            <p className="truncate text-[10px] tracking-wider text-fg-subtle uppercase">
              {pageMeta.subtitle}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefreshAll}
              className="rounded-lg p-2 text-fg-muted hover:bg-hover hover:text-fg-strong"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>

            <Link
              href="/"
              className="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg-strong sm:inline-flex"
            >
              <Store className="h-3.5 w-3.5" />
              Store
            </Link>

            <span
              className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-fg-faint'}`}
              title={isConnected ? 'Realtime connected' : 'Realtime offline'}
            />

            <ThemeToggle />

            {/* User Menu Dropdown */}
            <div className="relative" data-user-menu>
              <button
                type="button"
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                className="flex items-center gap-2 rounded-lg p-1.5 text-fg-muted hover:bg-hover hover:text-fg-strong"
                aria-expanded={isUserMenuOpen}
                aria-haspopup="true"
                aria-label="User menu"
              >
                <User className="h-5 w-5" />
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${isUserMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {isUserMenuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-xl border border-line bg-surface-raised py-1 shadow-xl">
                  <Link
                    href="/admin/profile"
                    className="flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-hover"
                    onClick={() => setIsUserMenuOpen(false)}
                  >
                    <User className="h-4 w-4" />
                    <span>My Profile</span>
                  </Link>
                  <Link
                    href="/admin/settings"
                    className="flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-hover"
                    onClick={() => setIsUserMenuOpen(false)}
                  >
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                  <hr className="my-1 border-line" />
                  <form action={logoutAction}>
                    <input type="hidden" name="returnTo" value="/login" />
                    <button
                      type="submit"
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50/50"
                    >
                      <LogOut className="h-4 w-4" />
                      <span>Logout</span>
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
