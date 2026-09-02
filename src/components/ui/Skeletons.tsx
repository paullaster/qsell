'use client';

export function SkeletonCard() {
  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 animate-pulse space-y-4">
      <div className="w-full h-48 bg-slate-800/60 rounded-xl" />
      <div className="space-y-2">
        <div className="h-4 bg-slate-800/80 rounded w-1/3" />
        <div className="h-5 bg-slate-700/80 rounded w-3/4" />
        <div className="h-4 bg-slate-800/60 rounded w-full" />
      </div>
      <div className="flex items-center justify-between pt-2">
        <div className="h-6 bg-slate-700/80 rounded w-1/4" />
        <div className="h-9 bg-slate-800 rounded-lg w-28" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 bg-slate-900/70 border border-slate-800/80 rounded-2xl p-4" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="h-80 bg-slate-900/70 border border-slate-800/80 rounded-2xl lg:col-span-2" />
        <div className="h-80 bg-slate-900/70 border border-slate-800/80 rounded-2xl" />
      </div>
    </div>
  );
}

export const SkeletonMetrics = SkeletonDashboard;

export function SkeletonTable() {
  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 space-y-4 animate-pulse">
      <div className="h-6 bg-slate-800 rounded w-1/4" />
      <div className="space-y-3 pt-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 bg-slate-800/40 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
