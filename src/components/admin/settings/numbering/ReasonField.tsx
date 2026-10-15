'use client';

import { useId, useState } from 'react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, fieldClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

export interface ReasonValue {
  code: string;
  text: string;
}

/** The lists of reasons a change can be explained by, one per screen family (each behind its own permission). */
export type ReasonSource = 'numbering-reasons' | 'approval-config-reasons' | 'approval-reasons' | 'pricing-reasons';

/**
 * "Why are you doing this?": a reason from the controlled list plus a comment, which some reasons
 * require. The list is read from the server when the field is opened, a page at a time, and searched
 * there. Used before any change that must be explainable later.
 */
export function ReasonField({
  value,
  onChange,
  source = 'numbering-reasons',
  showComment = true,
}: {
  value: ReasonValue;
  onChange: (next: ReasonValue) => void;
  /** Which list of reasons to offer. */
  source?: ReasonSource;
  /** Hide the comment box when the screen already asks for one. */
  showComment?: boolean;
}) {
  const uid = useId();
  const [choice, setChoice] = useState<Choice | null>(value.code === '' ? null : { id: value.code, label: value.code });
  // A reason cleared from outside (a form reset) clears the field too.
  const shown = value.code === '' ? null : choice?.id === value.code ? choice : { id: value.code, label: value.code };
  const commentRequired = shown?.meta?.requiresComment === '1';

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChoicePicker
        label="Reason"
        source={source}
        choice={shown}
        onChoice={(next) => {
          setChoice(next);
          onChange({ ...value, code: next?.id ?? '' });
        }}
        placeholder="Choose a reason…"
        required
      />
      {showComment ? (
        <Field id={`${uid}-c`} label={`Comment${commentRequired ? ' (required)' : ''}`}>
          <input id={`${uid}-c`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} className={fieldClass} required={commentRequired} />
        </Field>
      ) : null}
    </div>
  );
}

export function reasonReady(value: ReasonValue): boolean {
  return value.code !== '';
}
