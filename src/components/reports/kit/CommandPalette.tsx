'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Search } from 'lucide-react';
import { searchReports } from '@/lib/reports/search';
import { useModalKeys } from '@/components/ui/useModalKeys';

export interface PaletteItem {
  code: string;
  title: string;
  question: string;
  familyLabel: string;
  keywords: readonly string[];
  href: string;
}

/**
 * A search box that jumps to any report the person may open: press Ctrl or Command and K, type a few words, use the up and
 * down arrows, press Enter. It searches titles, the question each report answers, keywords and the family, and lists only
 * the reports the server already said this person may open.
 */
export function CommandPalette({ items }: { items: readonly PaletteItem[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="inline-flex min-h-11 w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-left text-sm text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 sm:w-80"
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="palette-open"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">Find a report…</span>
        <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold text-fg-subtle sm:inline">
          Ctrl K
        </kbd>
      </button>
      {open ? (
        <Palette
          items={items}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function Palette({ items, onClose }: { items: readonly PaletteItem[]; onClose: () => void }) {
  const router = useRouter();
  const dialog = useModalKeys<HTMLDivElement>(onClose);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchReports(items, query).slice(0, 12), [items, query]);
  const current = results[Math.min(active, Math.max(results.length - 1, 0))];

  useEffect(() => {
    input.current?.focus();
  }, []);

  const go = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    onClose();
    router.push(item.href);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-backdrop/70 p-3 pt-[12dvh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Find a report"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-fg-subtle" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current === undefined ? undefined : `${listId}-${current.code}`}
            aria-label="Search reports"
            placeholder="Sales, stock, VAT, who owes us…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(current);
              }
            }}
            className="min-h-12 flex-1 bg-transparent text-base text-fg-strong placeholder:text-fg-faint focus:outline-none"
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Reports"
          className="max-h-[50dvh] overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <li role="presentation" className="px-3 py-6 text-center text-sm text-fg-muted">
              No report matches “{query}”.
            </li>
          ) : null}
          {results.map((item) => (
            <li
              key={item.code}
              id={`${listId}-${item.code}`}
              role="option"
              aria-selected={item.code === current?.code}
              onMouseEnter={() => {
                setActive(results.indexOf(item));
              }}
              onClick={() => {
                go(item);
              }}
              className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${item.code === current?.code ? 'bg-hover' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-fg-strong">
                  {item.title}
                </span>
                <span className="block truncate text-xs text-fg-muted">{item.question}</span>
              </span>
              <span className="hidden shrink-0 text-[11px] text-fg-subtle sm:inline">
                {item.familyLabel}
              </span>
              {item.code === current?.code ? (
                <CornerDownLeft className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
