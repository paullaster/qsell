'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listPricingReasonsAction, searchProductsAction } from '@/server/domains/pricing/actions';
import {
  addProductGroupMembersAction,
  productGroupMembersAction,
  removeProductGroupMembersAction,
  saveProductGroupAction,
  type ProductGroupView,
} from '@/server/domains/pricing/guard-actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';

interface FormState {
  id?: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
}
const empty: FormState = { code: '', name: '', description: '', isActive: true };

export function ProductGroupsClient({
  groups,
  canManage,
}: {
  groups: ProductGroupView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [form, setForm] = useState<FormState | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    const r = await saveProductGroupAction(
      { ...form, description: form.description || null },
      reason,
    );
    setBusy(false);
    if (r.ok) {
      setForm(null);
      setReason({ code: '', text: '' });
      setMessage({ kind: 'ok', text: 'Group saved.' });
      router.refresh();
    } else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product groups"
        actions={
          canManage && !form ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => setForm({ ...empty })}
            >
              New group
            </button>
          ) : null
        }
      >
        A set of products you choose, such as a supplier's range or a clearance line, so a price
        floor can be set for all of them at once. A product can be in several groups; where their
        floors differ, the strictest applies.
      </PageHeader>
      <Notice message={message} />

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-3`} aria-label="Product group">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-code`} className={labelClass}>
                Code
              </label>
              <input
                id={`${uid}-code`}
                className={fieldClass}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="SUPPLIER-ACME"
                required
              />
            </div>
            <div>
              <label htmlFor={`${uid}-name`} className={labelClass}>
                Name
              </label>
              <input
                id={`${uid}-name`}
                className={fieldClass}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-desc`} className={labelClass}>
                Description (optional)
              </label>
              <input
                id={`${uid}-desc`}
                className={fieldClass}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
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
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || !reason.code}>
              {busy ? 'Saving…' : 'Save group'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState title="No product groups yet">
          Make a group, add products to it, then set a floor for the group under Price floors.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-fg-strong">
                    {g.name} <span className="text-xs font-normal text-fg-muted">{g.code}</span>
                  </p>
                  <p className="text-xs text-fg-muted">
                    {g.memberCount.toLocaleString()} product{g.memberCount === 1 ? '' : 's'}{' '}
                    {g.isActive ? null : <Chip tone="grey">Not in use</Chip>}
                  </p>
                  {g.description ? <p className="mt-1 text-sm text-fg">{g.description}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    aria-expanded={open === g.id}
                    onClick={() => setOpen(open === g.id ? null : g.id)}
                  >
                    {open === g.id ? 'Hide products' : 'Products'}
                  </button>
                  {canManage ? (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        setForm({
                          id: g.id,
                          code: g.code,
                          name: g.name,
                          description: g.description ?? '',
                          isActive: g.isActive,
                        })
                      }
                    >
                      Change
                    </button>
                  ) : null}
                </div>
              </div>
              {open === g.id ? (
                <Members group={g} canManage={canManage} onChanged={() => router.refresh()} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Members({
  group,
  canManage,
  onChanged,
}: {
  group: ProductGroupView;
  canManage: boolean;
  onChanged: () => void;
}) {
  const uid = useId();
  const [members, setMembers] = useState<
    Array<{ id: string; sku: string; name: string; cost: string }>
  >([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ id: string; name: string; sku: string }>>([]);
  const [paste, setPaste] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await productGroupMembersAction(group.id);
    if (r.ok) setMembers(r.data);
    else setMessage({ kind: 'error', text: r.error });
  }, [group.id]);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    let live = true;
    const t = setTimeout(() => {
      void searchProductsAction(q).then((r) => live && r.ok && setFound(r.data));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const run = async (work: () => Promise<{ ok: boolean; error?: string; text?: string }>) => {
    if (!reason.code) return setMessage({ kind: 'error', text: 'Choose a reason first.' });
    setBusy(true);
    setMessage(null);
    const r = await work();
    setBusy(false);
    if (r.ok) {
      setMessage({ kind: 'ok', text: r.text ?? 'Done.' });
      setQ('');
      setFound([]);
      setPaste('');
      await load();
      onChanged();
    } else setMessage({ kind: 'error', text: r.error ?? 'Something went wrong.' });
  };

  const add = (input: { productIds?: string[]; csv?: string }) =>
    run(async () => {
      const r = await addProductGroupMembersAction(group.id, input, reason);
      return r.ok
        ? {
            ok: true,
            text: `${r.data.added} added${r.data.alreadyIn ? `, ${r.data.alreadyIn} already in` : ''}.`,
          }
        : { ok: false, error: r.error };
    });
  const remove = (id: string) =>
    run(async () => {
      const r = await removeProductGroupMembersAction(group.id, [id], reason);
      return r.ok ? { ok: true, text: 'Removed.' } : { ok: false, error: r.error };
    });

  const inGroup = new Set(members.map((m) => m.id));
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-3">
      {canManage ? (
        <>
          <div>
            <label htmlFor={`${uid}-find`} className={labelClass}>
              Add a product
            </label>
            <input
              id={`${uid}-find`}
              className={`${fieldClass} sm:max-w-sm`}
              value={q}
              placeholder="Type a name or SKU…"
              onChange={(e) => setQ(e.target.value)}
            />
            {found.length > 0 ? (
              <ul className="mt-1 max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line sm:max-w-sm">
                {found.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      disabled={busy || inGroup.has(f.id)}
                      className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void add({ productIds: [f.id] })}
                    >
                      {f.name} <span className="text-fg-muted">{f.sku}</span>
                      {inGroup.has(f.id) ? ' · already in' : ''}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div>
            <label htmlFor={`${uid}-paste`} className={labelClass}>
              Or paste a list of SKUs (separated by commas, spaces or new lines)
            </label>
            <textarea
              id={`${uid}-paste`}
              className={`${fieldClass} sm:max-w-sm`}
              rows={3}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <button
              type="button"
              className={`${buttonClass} mt-2`}
              disabled={busy || paste.trim() === ''}
              onClick={() => void add({ csv: paste })}
            >
              Add these products
            </button>
          </div>
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
        </>
      ) : null}
      <Notice message={message} />
      {members.length === 0 ? (
        <p className="text-sm text-fg-muted">No products in this group yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>
                {m.name} <span className="text-fg-muted">{m.sku}</span>
              </span>
              {canManage ? (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void remove(m.id)}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {members.length >= 100 ? (
        <p className="text-xs text-fg-muted">Showing the first 100 products.</p>
      ) : null}
    </div>
  );
}
