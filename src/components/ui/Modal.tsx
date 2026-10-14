'use client';

import { X } from 'lucide-react';
import { useModalKeys } from './useModalKeys';

/**
 * A dialog over the page: Escape and the close button dismiss it, Tab stays inside it, focus goes
 * back to what opened it, and a click on the backdrop closes it.
 */
export function Modal({
  children,
  title,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  title: string;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialogRef = useModalKeys<HTMLElement>(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/70 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[94dvh] w-full overflow-y-auto rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:p-6 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-fg-strong">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
