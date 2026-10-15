'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  explainFloorAction,
  removeFloorRuleAction,
  setFloorRuleAction,
  type FloorsPageData,
} from '@/server/domains/pricing/guard-actions';
import type {
  FloorExplanation,
  FloorRuleView,
} from '@/server/domains/pricing/guard-config-service';
import type { FloorEnforcement, FloorScopeType } from '@/server/domains/pricing/domain/types';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { ProductPick } from './PriceLinesPanel';

const SCOPE_LABEL: Record<FloorScopeType, string> = {
  default: 'Everything',
  category: 'A category (and its sub-categories)',
  brand: 'A brand',
  product_group: 'A product group',
  product: 'One product',
};
const ORDER: FloorScopeType[] = ['product', 'product_group', 'brand', 'category', 'default'];

interface Form {
  scopeType: FloorScopeType;
  scopeRef: string;
  scopeLabel: string;
  markup: string;
  enforcement: FloorEnforcement;
  isActive: boolean;
  editing: boolean;
}
const blank: Form = {
  scopeType: 'category',
  scopeRef: '',
  scopeLabel: '',
  markup: '10',
  enforcement: 'approval',
  isActive: true,
  editing: false,
};

export function FloorsClient({ data, canManage }: { data: FloorsPageData; canManage: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<FloorRuleView | null>(null);

  const done = (text: string) => {
    setForm(null);
    setRemoving(null);
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text });
    router.refresh();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    const r = await setFloorRuleAction(
      {
        scopeType: form.scopeType,
        scopeRef: form.scopeRef,
        markupPercent: Number(form.markup),
        enforcement: form.enforcement,
        isActive: form.isActive,
      },
      reason,
    );
    setBusy(false);
    if (r.ok) done('Floor saved. It applies to the next sale or quote.');
    else setMessage({ kind: 'error', text: r.error });
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const r = await removeFloorRuleAction(removing.id, reason);
    setBusy(false);
    if (r.ok) done('Floor removed.');
    else setMessage({ kind: 'error', text: r.error });
  };

  const sorted = [...data.rules].sort(
    (a, b) =>
      ORDER.indexOf(a.scopeType) - ORDER.indexOf(b.scopeType) ||
      a.scopeLabel.localeCompare(b.scopeLabel),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Price floors"
        actions={
          canManage && !form ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => setForm({ ...blank })}
            >
              New floor
            </button>
          ) : null
        }
      >
        The lowest a product may be sold for: its cost plus a markup. The most specific floor
        applies: a product, then a group or brand, then its category (a sub-category before the
        category above it), then everything. A sale below the floor needs approval, or is refused.
      </PageHeader>
      <Notice message={message} />

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-3`} aria-label="Floor">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-type`} className={labelClass}>
                Applies to
              </label>
              <select
                id={`${uid}-type`}
                className={fieldClass}
                value={form.scopeType}
                disabled={form.editing}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scopeType: e.target.value as FloorScopeType,
                    scopeRef: '',
                    scopeLabel: '',
                  })
                }
              >
                {ORDER.map((t) => (
                  <option key={t} value={t}>
                    {SCOPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>

            {form.scopeType === 'category' ? (
              <div>
                <label htmlFor={`${uid}-cat`} className={labelClass}>
                  Category
                </label>
                <select
                  id={`${uid}-cat`}
                  className={fieldClass}
                  value={form.scopeRef}
                  disabled={form.editing}
                  required
                  onChange={(e) => setForm({ ...form, scopeRef: e.target.value })}
                >
                  <option value="">Choose a category…</option>
                  {data.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {'— '.repeat(c.depth)}
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {form.scopeType === 'brand' ? (
              <div>
                <label htmlFor={`${uid}-brand`} className={labelClass}>
                  Brand
                </label>
                <select
                  id={`${uid}-brand`}
                  className={fieldClass}
                  value={form.scopeRef}
                  disabled={form.editing}
                  required
                  onChange={(e) => setForm({ ...form, scopeRef: e.target.value })}
                >
                  <option value="">Choose a brand…</option>
                  {data.brands.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {form.scopeType === 'product_group' ? (
              <div>
                <label htmlFor={`${uid}-group`} className={labelClass}>
                  Product group
                </label>
                <select
                  id={`${uid}-group`}
                  className={fieldClass}
                  value={form.scopeRef}
                  disabled={form.editing}
                  required
                  onChange={(e) => setForm({ ...form, scopeRef: e.target.value })}
                >
                  <option value="">Choose a group…</option>
                  {data.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.code})
                    </option>
                  ))}
                </select>
                {data.groups.length === 0 ? (
                  <p className="mt-1 text-xs text-fg-muted">
                    There are no product groups yet. Make one under Product groups.
                  </p>
                ) : null}
              </div>
            ) : null}
            {form.scopeType === 'product' ? (
              <ProductPick
                value={form.scopeRef ? form.scopeLabel : ''}
                disabled={form.editing}
                onPick={(p) =>
                  setForm({ ...form, scopeRef: p.id, scopeLabel: `${p.name} (${p.sku})` })
                }
                onClear={() => setForm({ ...form, scopeRef: '', scopeLabel: '' })}
              />
            ) : null}

            <div>
              <label htmlFor={`${uid}-markup`} className={labelClass}>
                Markup over cost (%)
              </label>
              <input
                id={`${uid}-markup`}
                type="number"
                min={0}
                max={1000}
                step="0.1"
                inputMode="decimal"
                className={fieldClass}
                value={form.markup}
                onChange={(e) => setForm({ ...form, markup: e.target.value })}
                required
              />
              <p className="mt-1 text-xs text-fg-muted">
                0 means "never below cost". 20 means cost plus 20%, before tax.
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-enf`} className={labelClass}>
                A sale below it
              </label>
              <select
                id={`${uid}-enf`}
                className={fieldClass}
                value={form.enforcement}
                onChange={(e) =>
                  setForm({ ...form, enforcement: e.target.value as FloorEnforcement })
                }
              >
                <option value="approval">Needs approval</option>
                <option value="block">Is refused</option>
              </select>
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              In use
            </label>
          </div>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || !reason.code || (form.scopeType !== 'default' && !form.scopeRef)}
            >
              {busy ? 'Saving…' : 'Save floor'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {removing ? (
        <section aria-label="Remove floor" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            Remove the floor for <strong>{removing.scopeLabel}</strong>? Products it covered fall
            back to the next floor that applies, or to none.
          </p>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void remove()}
            >
              {busy ? 'Removing…' : 'Remove floor'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState title="No price floors yet">
          Until you add one, any product can be sold at any price. Start with a company-wide floor
          such as cost + 5%, then add stricter ones for categories, brands or single products.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                <tr>
                  <th className="px-4 py-3">Applies to</th>
                  <th className="px-4 py-3 text-right">Cost +</th>
                  <th className="px-4 py-3">Below it</th>
                  <th className="px-4 py-3">Status</th>
                  {canManage ? <th className="px-4 py-3 text-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {sorted.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-fg-strong">{r.scopeLabel}</div>
                      <div className="text-fg-muted">{SCOPE_LABEL[r.scopeType]}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{r.markupPercent}%</td>
                    <td className="px-4 py-3">
                      {r.enforcement === 'block' ? 'Refused' : 'Needs approval'}
                    </td>
                    <td className="px-4 py-3">
                      {r.isActive ? (
                        <Chip tone="green">In use</Chip>
                      ) : (
                        <Chip tone="grey">Not in use</Chip>
                      )}
                    </td>
                    {canManage ? (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className={buttonClass}
                            onClick={() => {
                              setRemoving(null);
                              setForm({
                                scopeType: r.scopeType,
                                scopeRef: r.scopeRef,
                                scopeLabel: r.scopeLabel,
                                markup: String(r.markupPercent),
                                enforcement: r.enforcement,
                                isActive: r.isActive,
                                editing: true,
                              });
                            }}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className={`${buttonClass} text-red-700`}
                            onClick={() => {
                              setForm(null);
                              setRemoving(r);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Explain />
    </div>
  );
}

/** Pick a product and see its floor, and why. */
function Explain() {
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<FloorExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (id: string) => {
    setBusy(true);
    setError(null);
    const r = await explainFloorAction(id);
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };

  return (
    <section aria-label="Check a product" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Check a product</h3>
      <p className="text-xs text-fg-muted">
        Pick a product to see its floor and which rule gave it.
      </p>
      <ProductPick
        value={label}
        onPick={(p) => {
          setLabel(`${p.name} (${p.sku})`);
          void check(p.id);
        }}
        onClear={() => {
          setLabel('');
          setResult(null);
        }}
      />
      {busy ? (
        <p role="status" className="text-sm text-fg-muted">
          Working it out…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {result ? (
        <div role="status" className="space-y-2 text-sm">
          <p className="font-semibold text-fg-strong">{result.summary}</p>
          {result.considered.length > 0 ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {result.considered.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {c.label}
                    <span className="block text-xs text-fg-muted">{c.why}</span>
                  </span>
                  <span className="font-mono text-xs">
                    {c.floorNet == null ? 'no cost' : c.floorNet.toFixed(2)}
                    {c.used ? <Chip tone="green">used</Chip> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
