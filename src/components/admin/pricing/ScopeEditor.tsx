'use client';

import { useEffect, useId, useState } from 'react';
import { searchCustomersAction, type PricingLookups } from '@/server/domains/pricing/actions';
import {
  SCOPE_DIMENSIONS,
  SCOPE_LABELS,
  type ScopeDimension,
  type Scopes,
} from '@/server/domains/pricing/domain/types';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { buttonClass, fieldClass } from '../approvals/shared';

const HELP: Record<ScopeDimension, string> = {
  customer: 'One named customer, for negotiated prices.',
  customer_group:
    'Everyone in a group such as Wholesale A. A customer in several groups is priced by the highest-priority one.',
  route: 'A delivery or van-sales route (type its code).',
  branch: 'Only sales made at these branches.',
  sales_type: 'Cash sales or credit sales.',
  channel: 'Which part of the business made the sale.',
  country: 'Two-letter country codes such as KE or UG.',
};

const SCOPE_OPS = [
  { value: 'in', label: 'Only these' },
  { value: 'not_in', label: 'Everything except these' },
] as const;

const CHANNEL_LABELS: Record<string, string> = {
  ecommerce: 'Web shop',
  sales_order: 'Sales orders',
  credit_sale: 'Credit sales',
  pos_cash_sale: 'POS cash sales',
};

/**
 * Chooses who and where a price list applies to. Nothing chosen means everyone, everywhere. Each
 * limit is "only these" or "everything except these".
 */
export function ScopeEditor({
  value,
  onChange,
  lookups,
  names,
  dimensions,
}: {
  value: Scopes;
  onChange: (next: Scopes) => void;
  lookups: PricingLookups;
  /** Names already known for customers chosen earlier. */
  names: Partial<Record<string, Record<string, string>>>;
  /** Which limits to offer. Defaults to all of them. */
  dimensions?: readonly ScopeDimension[];
}) {
  const [customerNames, setCustomerNames] = useState<Record<string, string>>(names.customer ?? {});
  const set = (d: ScopeDimension, rule: Scopes[ScopeDimension]) => {
    const others = Object.fromEntries(Object.entries(value).filter(([k]) => k !== d)) as Scopes;
    onChange(rule ? { ...others, [d]: rule } : others);
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold text-fg">Who and where it applies to</legend>
      <p className="text-xs text-fg-muted">
        Leave everything off and the list applies to every sale. The more you limit it, the more
        specific it is, and the more specific a list, the sooner it wins.
      </p>
      {(dimensions ?? SCOPE_DIMENSIONS).map((d) => {
        const rule = value[d];
        return (
          <div key={d} className="rounded-lg border border-line p-3">
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-fg-strong">
              <input
                type="checkbox"
                className="size-4"
                checked={Boolean(rule)}
                onChange={(e) => set(d, e.target.checked ? { op: 'in', values: [] } : undefined)}
              />
              {SCOPE_LABELS[d]}
            </label>
            <p className="ml-6 text-xs text-fg-muted">{HELP[d]}</p>
            {rule ? (
              <div className="mt-2 ml-0 space-y-2 sm:ml-6">
                <SegmentedChoice
                  label={`${SCOPE_LABELS[d]}: only or all except`}
                  hideLabel
                  value={rule.op}
                  options={SCOPE_OPS}
                  onChange={(op) => set(d, { ...rule, op })}
                />
                <ScopeValues
                  dimension={d}
                  rule={rule}
                  lookups={lookups}
                  customerNames={customerNames}
                  remember={(id, name) => setCustomerNames((m) => ({ ...m, [id]: name }))}
                  onChange={(next) => set(d, next)}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

type ScopeRule = NonNullable<Scopes[ScopeDimension]>;

/** The values of one limit: the control that fits what the limit is about. */
function ScopeValues({
  dimension: d,
  rule,
  lookups,
  customerNames,
  remember,
  onChange,
}: {
  dimension: ScopeDimension;
  rule: ScopeRule;
  lookups: PricingLookups;
  customerNames: Record<string, string>;
  remember: (id: string, name: string) => void;
  onChange: (next: ScopeRule) => void;
}) {
  const values = (next: string[]) => onChange({ ...rule, values: next });
  const choices: Partial<Record<ScopeDimension, { options: { value: string; label: string }[]; empty: string }>> = {
    customer_group: {
      options: lookups.groups.map((g) => ({ value: g.id, label: `${g.name} (${g.code})` })),
      empty: 'No customer groups yet. Create one under Customer groups.',
    },
    branch: {
      options: lookups.branches.map((b) => ({ value: b.id, label: `${b.name} (${b.code})` })),
      empty: 'No branches.',
    },
    sales_type: {
      options: lookups.salesTypes.map((v) => ({ value: v, label: v === 'cash' ? 'Cash sale' : 'Credit sale' })),
      empty: '',
    },
    channel: {
      options: lookups.channels.map((v) => ({ value: v, label: CHANNEL_LABELS[v] ?? v })),
      empty: '',
    },
  };
  const choice = choices[d];
  if (d === 'customer') {
    return (
      <CustomerPicker
        selected={rule.values}
        nameOf={(id) => customerNames[id] ?? id}
        remember={remember}
        onChange={values}
      />
    );
  }
  if (choice) {
    return <Checks options={choice.options} selected={rule.values} onChange={values} empty={choice.empty} />;
  }
  return (
    <TextValues
      label={SCOPE_LABELS[d]}
      values={rule.values}
      upper={d === 'country'}
      placeholder={d === 'country' ? 'KE' : 'ROUTE-1'}
      onChange={values}
    />
  );
}

function Checks({
  options,
  selected,
  onChange,
  empty,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  if (options.length === 0) return <p className="text-xs text-fg-muted">{empty}</p>;
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {options.map((o) => (
        <label key={o.value} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={selected.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
              )
            }
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function TextValues({
  label,
  values,
  onChange,
  upper,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  upper: boolean;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = upper ? draft.trim().toUpperCase() : draft.trim();
    if (v !== '' && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          aria-label={`Add ${label.toLowerCase()}`}
          className={`${fieldClass} sm:max-w-xs`}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className={buttonClass} onClick={add}>
          Add
        </button>
      </div>
      <Chips
        values={values}
        nameOf={(v) => v}
        onRemove={(v) => onChange(values.filter((x) => x !== v))}
      />
    </div>
  );
}

function Chips({
  values,
  nameOf,
  onRemove,
}: {
  values: string[];
  nameOf: (v: string) => string;
  onRemove: (v: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {values.map((v) => (
        <li
          key={v}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken py-0.5 pr-1 pl-3 text-xs text-fg-strong"
        >
          {nameOf(v)}
          <button
            type="button"
            aria-label={`Remove ${nameOf(v)}`}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full hover:bg-hover"
            onClick={() => onRemove(v)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function CustomerPicker({
  selected,
  onChange,
  nameOf,
  remember,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
  nameOf: (id: string) => string;
  remember: (id: string, name: string) => void;
}) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<{ q: string; rows: { id: string; number: string; name: string }[] }>({ q: '', rows: [] });
  const asked = useDebouncedValue(q.trim(), 250);
  useEffect(() => {
    if (asked.length < 2) return;
    let live = true;
    void searchCustomersAction(asked).then((r) => {
      if (live && r.ok) setAnswer({ q: asked, rows: r.data });
    });
    return () => {
      live = false;
    };
  }, [asked]);
  // Only an answer to what is typed now is shown; a shorter or changed search shows nothing stale.
  const found = asked.length >= 2 && answer.q === asked ? answer.rows : [];
  return (
    <div className="space-y-2">
      <label htmlFor={uid} className="sr-only">
        Find a customer
      </label>
      <input
        id={uid}
        className={`${fieldClass} sm:max-w-sm`}
        value={q}
        placeholder="Type a name or number…"
        onChange={(e) => setQ(e.target.value)}
      />
      {found.length > 0 ? (
        <ul className="max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line">
          {found
            .filter((f) => !selected.includes(f.id))
            .map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover"
                  onClick={() => {
                    remember(f.id, f.name);
                    onChange([...selected, f.id]);
                    setQ('');
                  }}
                >
                  {f.name} <span className="text-fg-muted">{f.number}</span>
                </button>
              </li>
            ))}
        </ul>
      ) : null}
      <Chips
        values={selected}
        nameOf={nameOf}
        onRemove={(v) => onChange(selected.filter((x) => x !== v))}
      />
    </div>
  );
}
