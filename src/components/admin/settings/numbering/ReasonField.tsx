'use client';

import { useEffect, useId, useState } from 'react';
import { listReasonCodesAction } from '@/server/kernel/numbering/actions';

export interface ReasonValue {
  code: string;
  text: string;
}

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none';

/**
 * "Why are you doing this?" — a reason from the controlled list plus a comment, which some
 * reasons require. Used before any change that must be explainable later.
 */
type ReasonLoader = () => Promise<
  | { ok: true; data: { code: string; description: string; requiresComment: boolean }[] }
  | { ok: false; error: string }
>;

export function ReasonField({
  value,
  onChange,
  load = listReasonCodesAction,
  showComment = true,
}: {
  value: ReasonValue;
  onChange: (next: ReasonValue) => void;
  /** Where the reasons come from; defaults to the numbering screens' permission. */
  load?: ReasonLoader;
  /** Hide the comment box when the screen already asks for one. */
  showComment?: boolean;
}) {
  const uid = useId();
  const [reasons, setReasons] = useState<
    { code: string; description: string; requiresComment: boolean }[]
  >([]);

  useEffect(() => {
    void load().then((r) => {
      if (r.ok) setReasons(r.data);
    });
  }, [load]);

  const chosen = reasons.find((r) => r.code === value.code);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${uid}-r`} className="mb-1 block text-xs font-semibold text-fg">
          Reason
        </label>
        <select
          id={`${uid}-r`}
          value={value.code}
          onChange={(e) => onChange({ ...value, code: e.target.value })}
          className={fieldClass}
          required
        >
          <option value="">Choose a reason…</option>
          {reasons.map((r) => (
            <option key={r.code} value={r.code}>
              {r.description}
            </option>
          ))}
        </select>
      </div>
      {showComment ? (
        <div>
          <label htmlFor={`${uid}-c`} className="mb-1 block text-xs font-semibold text-fg">
            Comment{chosen?.requiresComment ? ' (required)' : ''}
          </label>
          <input
            id={`${uid}-c`}
            value={value.text}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
            className={fieldClass}
            required={chosen?.requiresComment}
          />
        </div>
      ) : null}
    </div>
  );
}

export function reasonReady(value: ReasonValue): boolean {
  return value.code !== '';
}
