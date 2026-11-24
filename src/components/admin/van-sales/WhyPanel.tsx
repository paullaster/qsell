'use client';

import { useId, useState } from 'react';
import { Field, buttonClass, dangerClass, fieldClass } from '@/components/ui/screen-kit';
import { REASON_LIMIT } from '@/lib/van-sales/people';

/** Asks why, in the person's own words, right where the button was, before a van is stopped or a rep paused or ended. Nothing happens until it is confirmed. */
export function WhyPanel({ label, action, busy, onConfirm, onCancel }: { label: string; action: string; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const clean = reason.trim();
  const ready = clean.length >= REASON_LIMIT.min && clean.length <= REASON_LIMIT.max;
  return (
    <form
      aria-label={label}
      className="space-y-2 rounded-lg border border-line bg-surface-sunken p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onConfirm(clean);
      }}
    >
      <Field id={`${uid}-why`} label="Why?" hint={`${String(REASON_LIMIT.min)} to ${String(REASON_LIMIT.max)} characters. It is kept with the change.`}>
        <textarea id={`${uid}-why`} className={`${fieldClass} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_LIMIT.max} autoFocus />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={dangerClass} disabled={busy || !ready}>{busy ? 'Saving…' : action}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Keep it as it is</button>
      </div>
    </form>
  );
}
