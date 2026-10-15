'use client';

import { useId, useState } from 'react';
import { previewNumberAction } from '@/server/kernel/numbering/actions';
import type { NumberPreview } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, cardClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { emptyToNull, has } from '@/lib/values';

const failedPreview = (message: string): NumberPreview => ({
  ok: false,
  number: null,
  seriesCode: null,
  lineNo: null,
  note: null,
  error: { code: 'INVALID_CONFIG', message },
  trace: [],
});

/** Shows which number a document would get, and why, without using one up. */
export function SeriesTryItCard({ seriesCode }: { seriesCode: string }) {
  const uid = useId();
  const [date, setDate] = useState(() => businessDate());
  const [branch, setBranch] = useState<Choice | null>(null);
  const [result, setResult] = useState<NumberPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const res = await attempt(previewNumberAction({ seriesCode, branchId: emptyToNull(branch?.id), date }));
    setResult(res.ok ? res.data : failedPreview(res.error));
    setBusy(false);
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Try it">
      <div>
        <h3 className="text-base font-bold text-fg-strong">Try it</h3>
        <p className="text-xs text-fg-muted">See which number a document would get, and why. Nothing is used up.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field id={`${uid}-d`} label="Document date">
          <input id={`${uid}-d`} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
        </Field>
        <ChoicePicker label="Branch" source="numbering-branches" choice={branch} onChoice={setBranch} placeholder="No branch" />
        <button type="button" className={primaryClass} disabled={busy} onClick={() => void run()}>
          Show next number
        </button>
      </div>
      <div aria-live="polite">
        {result === null ? null : (
          <div className="space-y-2">
            {result.ok ? (
              <p className="text-sm">
                Next number: <span className="font-mono text-lg font-bold text-fg-strong">{result.number}</span> <span className="text-fg-muted">(line {result.lineNo})</span>
              </p>
            ) : (
              <p role="alert" className="text-sm text-red-700">
                {result.error?.message}
              </p>
            )}
            {has(result.note) ? <p className="text-xs text-fg-muted">{result.note}</p> : null}
            {result.trace.length === 0 ? null : (
              <ul className="space-y-1 text-xs">
                {result.trace.map((t) => (
                  <li key={t.lineNo} className="flex gap-2">
                    <span className={`w-16 shrink-0 font-semibold ${t.accepted ? 'text-emerald-700' : 'text-fg-muted'}`}>Line {t.lineNo}</span>
                    <span className="text-fg">
                      {t.accepted ? 'usable' : 'skipped'} — {t.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
