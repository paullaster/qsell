'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { resetWeightsAction,
  setWeightsAction,
} from '@/server/domains/pricing/actions';
import {
  DEFAULT_WEIGHTS,
  SCOPE_DIMENSIONS,
  SCOPE_LABELS,
  type SpecificityWeights,
} from '@/server/domains/pricing/domain/types';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';

const ROWS: Array<{ key: keyof SpecificityWeights; label: string }> = [
  { key: 'contract', label: 'A contract price' },
  ...SCOPE_DIMENSIONS.map((d) => ({
    key: d,
    label: `Limited to a ${SCOPE_LABELS[d].toLowerCase()}`,
  })),
];

export function RulesClient({
  weights,
  canManage,
}: {
  weights: SpecificityWeights;
  canManage: boolean;
}) {
  const uid = useId();
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(ROWS.map((r) => [r.key, String(weights[r.key])])),
  );
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const changed = ROWS.filter((r) => Number(draft[r.key]) !== weights[r.key]);
  const order = [...ROWS].sort((a, b) => Number(draft[b.key]) - Number(draft[a.key]));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const patch = Object.fromEntries(changed.map((r) => [r.key, Number(draft[r.key])]));
    const r = await setWeightsAction(patch, reason);
    setBusy(false);
    if (r.ok) {
      setMessage({ kind: 'ok', text: 'Saved. New sales are priced with these weights.' });
      setReason({ code: '', text: '' });
      router.refresh();
    } else setMessage({ kind: 'error', text: r.error });
  };
  const reset = async () => {
    setBusy(true);
    const r = await resetWeightsAction(reason);
    setBusy(false);
    if (r.ok) {
      setDraft(Object.fromEntries(ROWS.map((x) => [x.key, String(r.data[x.key])])));
      setMessage({ kind: 'ok', text: 'Back to the standard weights.' });
      setReason({ code: '', text: '' });
      router.refresh();
    } else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Price rules">
        When more than one price list could price a sale, the one that is more specific wins. Each
        kind of limit adds its weight to a list&rsquo;s specificity. The standard weights are powers
        of two in this order, so a list limited to a customer always beats one limited only to a
        group, branch and channel together. Change them only if your trade ranks things differently,
        for example a route above a group.
      </PageHeader>
      <section className={`${cardClass} space-y-3`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">Specificity weights</caption>
            <thead className="border-b border-line text-xs text-fg-muted">
              <tr>
                <th scope="col" className="py-2 pr-3">
                  A price list that is…
                </th>
                <th scope="col" className="py-2 pr-3">
                  Standard
                </th>
                <th scope="col" className="py-2">
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-0">
                  <th scope="row" className="py-2 pr-3 font-medium text-fg-strong">
                    {r.label}
                  </th>
                  <td className="py-2 pr-3 text-fg-muted tabular-nums">{DEFAULT_WEIGHTS[r.key]}</td>
                  <td className="py-2">
                    <label htmlFor={`${uid}-${r.key}`} className="sr-only">
                      Weight for {r.label.toLowerCase()}
                    </label>
                    <input
                      id={`${uid}-${r.key}`}
                      type="number"
                      min={0}
                      max={100000}
                      step={1}
                      disabled={!canManage}
                      className={`${fieldClass} w-28`}
                      value={draft[r.key]}
                      onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-fg-muted">
          Counts most to least:{' '}
          {order.map((r) => r.label.replace(/^Limited to a /, '').replace(/^A /, '')).join(' → ')}.
          A list that excludes something (&ldquo;everything except&rdquo;) adds nothing.
        </p>
        {canManage ? (
          <>
            <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || changed.length === 0 || !reason.code}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save weights'}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !reason.code}
                onClick={() => void reset()}
              >
                Back to standard
              </button>
            </div>
            <p className="text-xs text-amber-700">
              Changing a weight can change which list prices existing customers from now on. Use the
              Price check to try a sale first.
            </p>
          </>
        ) : null}
        <Notice message={message} />
      </section>
    </div>
  );
}
