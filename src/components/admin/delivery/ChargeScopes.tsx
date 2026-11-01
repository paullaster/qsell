'use client';

import { useId } from 'react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { SCOPE_KEYS, type PolicyForm, type ScopeDimensionKey } from '@/lib/charge-policy-form';

const WORDS: Record<ScopeDimensionKey, { title: string; help: string; source: string; add: string }> = {
  branch: { title: 'Branch', help: 'Only orders that this branch processes.', source: 'delivery-branches', add: 'Add a branch' },
  customer_group: { title: 'Customer group', help: 'Only customers in these groups, such as Wholesale.', source: 'delivery-customer-groups', add: 'Add a group' },
  channel: { title: 'Where the order comes from', help: 'The web shop, sales orders, credit sales or the point of sale.', source: 'delivery-channels', add: 'Add a channel' },
};

/**
 * Who a charge policy is for. Nothing chosen means every order. The more it is limited, the more specific it is, and the more specific
 * a policy, the sooner it is chosen over a general one.
 */
export function ChargeScopes({ value, onChange, disabled }: { value: PolicyForm['scopes']; onChange: (next: PolicyForm['scopes']) => void; disabled: boolean }) {
  const uid = useId();
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-semibold text-fg">Who it is for</legend>
      <p className="text-xs text-fg-muted">Leave everything unticked and the policy applies to every order. The more you limit it, the more specific it is, and a more specific policy is chosen before a general one.</p>
      {SCOPE_KEYS.map((key) => {
        const line = value[key];
        const words = WORDS[key];
        const set = (next: PolicyForm['scopes'][ScopeDimensionKey]) => {
          const others = Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) as PolicyForm['scopes'];
          onChange(next === undefined ? others : { ...others, [key]: next });
        };
        return (
          <div key={key} className="rounded-lg border border-line p-3">
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-fg-strong">
              <input type="checkbox" className="size-4" checked={line !== undefined} onChange={(e) => set(e.target.checked ? { op: 'in', chosen: [] } : undefined)} />
              {words.title}
            </label>
            <p className="ml-6 text-xs text-fg-muted">{words.help}</p>
            {line === undefined ? null : (
              <div className="mt-2 space-y-2 sm:ml-6">
                <div role="radiogroup" aria-label={`${words.title}: only or all except`} className="flex flex-wrap gap-x-4">
                  {(['in', 'not_in'] as const).map((op) => (
                    <label key={op} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                      <input type="radio" name={`${uid}-${key}`} checked={line.op === op} onChange={() => set({ ...line, op })} />
                      {op === 'in' ? 'Only these' : 'Everything except these'}
                    </label>
                  ))}
                </div>
                {line.chosen.length === 0 ? <p className="text-xs text-amber-700">Pick at least one, or untick {words.title.toLowerCase()}.</p> : null}
                <ul className="flex flex-wrap gap-2" aria-label={`${words.title} chosen`}>
                  {line.chosen.map((c) => (
                    <li key={c.id} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line bg-surface-sunken pl-3 text-xs text-fg">
                      <span className="break-words">{c.label}</span>
                      <button type="button" className="inline-flex size-10 items-center justify-center rounded-full text-fg-muted hover:text-fg-strong" aria-label={`Remove ${c.label}`} onClick={() => set({ ...line, chosen: line.chosen.filter((x) => x.id !== c.id) })}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="max-w-sm">
                  <ChoicePicker
                    label={words.add}
                    source={words.source}
                    choice={null}
                    placeholder={words.add}
                    onChoice={(choice) => {
                      if (choice !== null && !line.chosen.some((c) => c.id === choice.id)) set({ ...line, chosen: [...line.chosen, { id: choice.id, label: choice.label }] });
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
