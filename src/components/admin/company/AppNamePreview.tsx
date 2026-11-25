'use client';

import { AppImage } from '@/components/ui/AppImage';
import { firstFilled, has } from '@/lib/values';

/** How the app looks once installed: the icon with the name under it as a phone shows it, and the full name as the install box shows it. */
export function AppNamePreview({ name, shortName, logoUrl, accentColor }: { name: string; shortName: string; logoUrl: string | null; accentColor: string }) {
  const initial = (firstFilled(name.trim().charAt(0)) ?? 'C').toUpperCase();
  return (
    <div className="flex items-center gap-5 rounded-xl border border-line bg-surface px-4 py-3" aria-label="How the installed app will look">
      <div className="flex w-20 flex-col items-center gap-1.5">
        <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl text-xl font-bold text-white shadow-md ring-1 ring-line-strong" style={{ backgroundColor: has(logoUrl) ? '#ffffff' : accentColor }}>
          {has(logoUrl) ? <AppImage src={logoUrl} alt="" fill sizes="56px" unoptimized className="object-contain p-1" /> : initial}
        </span>
        <span className="w-full truncate text-center text-xs font-medium text-fg-strong" data-testid="app-short-preview">
          {shortName}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-fg-muted">Install box</p>
        <p className="break-words text-sm font-semibold text-fg-strong" data-testid="app-name-preview">
          {name}
        </p>
      </div>
    </div>
  );
}
