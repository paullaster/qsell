'use client';

import { useState } from 'react';
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
}

/**
 * A destructive action that asks once, right where the button was, instead of a browser dialog:
 * the first press asks, the second does it, and "Keep it" puts everything back.
 */
export function InlineConfirm({ label, action, confirm = 'Yes, do it', busy = false, onConfirm }: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={dangerClass} onClick={() => setAsking(true)} disabled={busy} aria-label={label}>
        {action}
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
