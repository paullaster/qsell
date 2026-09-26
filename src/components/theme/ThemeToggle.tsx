'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';
import type { ThemeMode } from '@/config/theme';

const OPTIONS = [
  { mode: 'light', label: 'Light', description: 'Always light', icon: Sun },
  { mode: 'dark', label: 'Dark', description: 'Always dark', icon: Moon },
  { mode: 'system', label: 'System', description: 'Match this device', icon: Monitor },
] as const satisfies readonly {
  mode: ThemeMode;
  label: string;
  description: string;
  icon: typeof Sun;
}[];

const FALLBACK_ICON = Monitor;

/**
 * Scheme switcher. Rendered wherever the user might want to change it —
 * storefront navbar, admin header and the auth screens.
 *
 * The trigger shows the current *choice* (not the resolved scheme) so "System"
 * stays visibly distinct from an explicit light/dark pick.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { mode, resolvedTheme, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Move focus into the menu so keyboard users land on the current selection.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const TriggerIcon = OPTIONS.find((option) => option.mode === mode)?.icon ?? FALLBACK_ICON;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Colour scheme: ${mode}. Change appearance`}
        title={`Appearance: ${mode}`}
        data-resolved-theme={resolvedTheme}
        className="rounded-lg border border-line bg-surface-sunken p-2 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <TriggerIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label="Colour scheme"
          className="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-xl border border-line bg-surface p-1.5 shadow-xl"
        >
          {OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const selected = option.mode === mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setMode(option.mode);
                  close(true);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  selected ? 'bg-hover text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
                }`}
              >
                <OptionIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{option.label}</span>
                  <span className="block text-[10px] text-fg-subtle">{option.description}</span>
                </span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
