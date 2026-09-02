'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { AdminNavItem } from '@/config/admin-nav';
import { getNavItemChildren } from '@/config/admin-nav';

interface AdminNavHubProps {
  section: AdminNavItem;
}

/** Index screen for a nav parent — lists installed children from central config. */
export function AdminNavHub({ section }: AdminNavHubProps) {
  const children = getNavItemChildren(section);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">{section.title}</h2>
        {section.description ? (
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">{section.description}</p>
        ) : null}
      </div>

      {children.length === 0 ? (
        <p className="text-sm text-zinc-500">No installed modules in this section yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {children.map((child) => (
            <Link
              key={child.id}
              href={child.disabled ? '#' : child.href}
              aria-disabled={child.disabled || undefined}
              className={`group flex items-start justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors ${
                child.disabled
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:border-indigo-500/40 hover:bg-zinc-900'
              }`}
            >
              <div className="min-w-0">
                <p className="font-semibold text-white">{child.title}</p>
                {child.description ? (
                  <p className="mt-1 text-xs leading-relaxed text-zinc-400">{child.description}</p>
                ) : null}
                {child.disabled ? (
                  <p className="mt-2 text-[10px] tracking-wider text-amber-500/80 uppercase">
                    Disabled
                  </p>
                ) : null}
              </div>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600 group-hover:text-indigo-400" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
