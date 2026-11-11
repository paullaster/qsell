'use client';

import React, { useEffect, useState } from 'react';
import type { DocTocItem } from '@/lib/docs/types';

interface DocsTocProps {
  readonly items: readonly DocTocItem[];
}

export function DocsToc({ items }: DocsTocProps) {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    if (items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      {
        rootMargin: '-80px 0px -70% 0px',
        threshold: 0,
      },
    );

    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className="space-y-1 text-xs" aria-label="Table of contents">
      <div className="mb-2 font-semibold tracking-wider text-fg-subtle uppercase">On this page</div>
      <div className="max-h-[calc(100vh-14rem)] space-y-1 overflow-y-auto border-l border-line pl-2.5">
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`block truncate py-1 transition-colors ${
                item.level === 3 ? 'pl-3 text-[11px]' : 'font-medium'
              } ${
                isActive
                  ? '-ml-[11px] border-l-2 border-indigo-600 pl-2.5 font-semibold text-indigo-600 dark:text-indigo-400'
                  : 'text-fg-muted hover:text-fg-strong'
              }`}
            >
              {item.text}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
