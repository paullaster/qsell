'use client';

import { productGridClassName } from '@/config/company-ui';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';

export function SkeletonCard() {
  return (
    <div className="animate-pulse space-y-4 rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5">
      <div className="h-48 w-full rounded-xl bg-slate-800/60" />
      <div className="space-y-2">
        <div className="h-4 w-1/3 rounded bg-slate-800/80" />
        <div className="h-5 w-3/4 rounded bg-slate-700/80" />
        <div className="h-4 w-full rounded bg-slate-800/60" />
      </div>
      <div className="flex items-center justify-between pt-2">
        <div className="h-6 w-1/4 rounded bg-slate-700/80" />
        <div className="h-9 w-28 rounded-lg bg-slate-800" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  const { productGrid } = useCompanyUiConfig();
  return (
    <div className={productGridClassName(productGrid.desktopColumns)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-28 rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="h-80 rounded-2xl border border-slate-800/80 bg-slate-900/70 lg:col-span-2" />
        <div className="h-80 rounded-2xl border border-slate-800/80 bg-slate-900/70" />
      </div>
    </div>
  );
}

export const SkeletonMetrics = SkeletonDashboard;

export function SkeletonTable() {
  return (
    <div className="animate-pulse space-y-4 rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6">
      <div className="h-6 w-1/4 rounded bg-slate-800" />
      <div className="space-y-3 pt-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-slate-800/40" />
        ))}
      </div>
    </div>
  );
}
