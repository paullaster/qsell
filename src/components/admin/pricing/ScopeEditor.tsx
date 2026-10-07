'use client';

import { useEffect, useId, useState } from 'react';
import { searchCustomersAction, type PricingLookups } from '@/server/domains/pricing/actions';
import {
  SCOPE_DIMENSIONS,
  SCOPE_LABELS,
  type ScopeDimension,
  type Scopes,
} from '@/server/domains/pricing/domain/types';
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
}: {
  value: Scopes;
  onChange: (next: Scopes) => void;
  lookups: PricingLookups;
  /** Names already known for customers chosen earlier. */
  names: Partial<Record<string, Record<string, string>>>;
}) {
  const [customerNames, setCustomerNames] = useState<Record<string, string>>(names.customer ?? {});
  const set = (d: ScopeDimension, rule: Scopes[ScopeDimension]) => {
    const next = { ...value };
    if (rule) next[d] = rule;
    else delete next[d];
    onChange(next);
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold text-fg">Who and where it applies to</legend>
      <p className="text-xs text-fg-muted">
        Leave everything off and the list applies to every sale. The more you limit it, the more
        specific it is, and the more specific a list, the sooner it wins.
      </p>
      {SCOPE_DIMENSIONS.map((d) => {
        const rule = value[d];
        return (
          <div key={d} className="rounded-lg border border-line p-3">
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-fg-strong">
              <input
                type="checkbox"
                className="size-4"
                checked={!!rule}
                onChange={(e) => set(d, e.target.checked ? { op: 'in', values: [] } : undefined)}
              />
              {SCOPE_LABELS[d]}
            </label>
            <p className="ml-6 text-xs text-fg-muted">{HELP[d]}</p>
            {rule ? (
              <div className="mt-2 ml-0 space-y-2 sm:ml-6">
                <select
                  aria-label={`${SCOPE_LABELS[d]}: only or all except`}
                  className={`${fieldClass} sm:max-w-xs`}
                  value={rule.op}
                  onChange={(e) => set(d, { ...rule, op: e.target.value as 'in' | 'not_in' })}
                >
                  <option value="in">Only these</option>
                  <option value="not_in">Everything except these</option>
                </select>
                {d === 'customer' ? (
                  <CustomerPicker
                    selected={rule.values}
                    nameOf={(id) => customerNames[id] ?? id}
                    remember={(id, name) => setCustomerNames((m) => ({ ...m, [id]: name }))}
                    onChange={(values) => set(d, { ...rule, values })}
                  />
                ) : d === 'customer_group' ? (
                  <Checks
                    options={lookups.groups.map((g) => ({
                      value: g.id,
                      label: `${g.name} (${g.code})`,
                    }))}
                    selected={rule.values}
                    onChange={(values) => set(d, { ...rule, values })}
                    empty="No customer groups yet. Create one under Customer groups."
                  />
                ) : d === 'branch' ? (
                  <Checks
                    options={lookups.branches.map((b) => ({
                      value: b.id,
                      label: `${b.name} (${b.code})`,
                    }))}
                    selected={rule.values}
                    onChange={(values) => set(d, { ...rule, values })}
                    empty="No branches."
                  />
                ) : d === 'sales_type' ? (
                  <Checks
                    options={lookups.salesTypes.map((v) => ({
                      value: v,
                      label: v === 'cash' ? 'Cash sale' : 'Credit sale',
                    }))}
                    selected={rule.values}
                    onChange={(values) => set(d, { ...rule, values })}
                    empty=""
                  />
                ) : d === 'channel' ? (
                  <Checks
                    options={lookups.channels.map((v) => ({
                      value: v,
                      label: CHANNEL_LABELS[v] ?? v,
                    }))}
                    selected={rule.values}
                    onChange={(values) => set(d, { ...rule, values })}
                    empty=""
                  />
                ) : (
                  <TextValues
                    label={SCOPE_LABELS[d]}
                    values={rule.values}
                    upper={d === 'country'}
                    placeholder={d === 'country' ? 'KE' : 'ROUTE-1'}
                    onChange={(values) => set(d, { ...rule, values })}
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

function Checks({
  options,
  selected,
  onChange,
  empty,
}: {
  options: Array<{ value: string; label: string }>;
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
    if (v && !values.includes(v)) onChange([...values, v]);
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
  const [found, setFound] = useState<Array<{ id: string; number: string; name: string }>>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void searchCustomersAction(q).then((r) => {
        if (live && r.ok) setFound(r.data);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
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
