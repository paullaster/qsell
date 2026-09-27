'use client';

import { AppImage } from '@/components/ui/AppImage';

export interface CompanyBrandProps {
  tradingName: string;
  tagline?: string | null;
  logoUrl?: string | null;
  accentColor?: string;
  size?: 'sm' | 'md';
  subtitle?: string | null;
  className?: string;
}

export function CompanyBrand({
  tradingName,
  tagline,
  logoUrl,
  accentColor = '#4F46E5',
  size = 'md',
  subtitle,
  className = '',
}: CompanyBrandProps) {
  const mark = size === 'sm' ? 'h-7 w-7 text-sm' : 'h-9 w-9 text-lg';
  const title = size === 'sm' ? 'text-sm' : 'text-base';
  const initial = (tradingName.trim().charAt(0) || 'C').toUpperCase();
  const line = subtitle ?? tagline;

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {logoUrl ? (
        <span
          className={`relative ${mark} overflow-hidden rounded-lg bg-white/5 ring-1 ring-line-strong`}
        >
          <AppImage
            src={logoUrl}
            alt={`${tradingName} logo`}
            fill
            sizes="36px"
            unoptimized
            className="object-contain"
          />
        </span>
      ) : (
        <div
          className={`flex ${mark} items-center justify-center rounded-lg font-bold text-white shadow-md`}
          style={{ backgroundColor: accentColor }}
        >
          {initial}
        </div>
      )}
      <div className="min-w-0">
        <span className={`block truncate ${title} font-bold tracking-tight text-fg-strong`}>
          {tradingName}
        </span>
        {line ? (
          <span className="-mt-0.5 block truncate text-[10px] tracking-wider text-fg-subtle uppercase">
            {line}
          </span>
        ) : null}
      </div>
    </div>
  );
}
