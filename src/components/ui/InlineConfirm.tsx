'use client';

import { useState, type ReactNode } from 'react';
import { buttonClass, dangerClass } from './screen-kit';

interface InlineConfirmProps {
  /** What the person is about to do to what, for example "Delete dimension WH". Read out by screen readers. */
  label: string;
  /** The word on the button before asking, for example "Delete". */
  action: string;
  /** The word on the button that does it, for example "Delete for good". */
  confirm?: string;
  busy?: boolean;
  onConfirm: () => void;
  icon?: ReactNode;
  iconOnly?: boolean;
  title?: string;
}

/**
 * A destructive action that asks once, right where the button was, instead of a browser dialog:
 * the first press asks, the second does it, and "Keep it" puts everything back.
 */
export function InlineConfirm({
  label,
  action,
  confirm = 'Yes, do it',
  busy = false,
  onConfirm,
  icon,
  iconOnly = false,
  title,
}: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={iconOnly ? `${dangerClass} h-10 w-10 px-0` : dangerClass}
        onClick={() => setAsking(true)}
        disabled={busy}
        aria-label={label}
        title={title ?? (iconOnly ? label : undefined)}
      >
        {iconOnly ? (icon ?? <span className="sr-only">{action}</span>) : action}
      </button>
    );
  }
  return (
    <span role="group" aria-label={label} className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={dangerClass}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={busy}
        aria-label={`Confirm: ${label}`}
        autoFocus
      >
        {confirm}
      </button>
      <button type="button" className={buttonClass} onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  );
}
