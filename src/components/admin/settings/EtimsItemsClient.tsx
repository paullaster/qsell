'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { etimsItemsPageAction, listRemoteEtimsItemsAction, reconcileEtimsItemAction, registerEtimsItemAction, removeEtimsItemAction, updateEtimsItemAction, updateEtimsStockAction, type ActionResult, type EtimsItemView, type listEtimsTargetsAction } from '@/server/domains/kra/etims/actions';
import type { EtimsTargetView, RemoteEtimsItem } from '@/server/domains/kra/etims/item-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, fieldClass, LoadFailed, PageHeader } from '@/components/ui/screen-kit';
import { branchOfScope, scopeKey } from '@/lib/etims-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { EtimsItemCard } from './EtimsItemCard';
import { EtimsRegisterForm } from './EtimsRegisterForm';
import { EtimsRemoteTable } from './EtimsRemoteTable';

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

interface Props {
  targetsPromise: ReturnType<typeof listEtimsTargetsAction>;
  /** The first page of the first usable target, started alongside the targets. */
  firstItems: Promise<Awaited<ReturnType<typeof etimsItemsPageAction>> | null>;
}

export function EtimsItemsClient({ targetsPromise, firstItems }: Props) {
  const targets = use(targetsPromise);
  const first = use(firstItems);
  if (!targets.ok) return <LoadFailed error={targets.error} />;
  if (targets.data.length === 0) return <NothingToManage />;
  return <Items targets={targets.data} first={first} />;
}

function NothingToManage() {
  return (
    <div className="max-w-2xl space-y-2">
      <PageHeader title="eTIMS items" />
      <p className="text-sm text-fg-muted">
        eTIMS items are available only when the company mode, or the mode of a branch that acts independently, is set to eTIMS. Configure that under{' '}
        <Link href={`${ITEMS_PATH}/company-mode`} className="font-semibold text-indigo-500 underline">
          Company Mode
        </Link>{' '}
        or{' '}
        <Link href={`${ITEMS_PATH}/branch-modes`} className="font-semibold text-indigo-500 underline">
          Branch Modes
        </Link>
        .
      </p>
    </div>
  );
}

const targetChoice = (t: EtimsTargetView): Choice => ({ id: scopeKey(t), label: t.scope === 'company' ? 'Company (all branches that do not act independently)' : `${t.label} (${t.code ?? ''}) — independent branch` });

function Items({ targets, first }: { targets: EtimsTargetView[]; first: Awaited<ReturnType<typeof etimsItemsPageAction>> | null }) {
  const firstTarget = targets[0];
  const [chosen, setChosen] = useState<Choice | null>(firstTarget === undefined ? null : targetChoice(firstTarget));
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<RemoteEtimsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const key = chosen?.id ?? 'company';
  const target = targets.find((t) => scopeKey(t) === key) ?? firstTarget;
  const branchId = branchOfScope(key);
  const usable = target?.usable === true;

  const list = usePagedList<EtimsItemView, { branchId: string | null; query: string; usable: boolean }>({
    load: (filters, cursor) => (filters.usable ? etimsItemsPageAction({ branchId: filters.branchId, query: filters.query, cursor }) : Promise.resolve({ ok: true as const, data: { rows: [], nextCursor: null } })),
    filters: { branchId, query: query.trim(), usable },
    initialPage: first ?? undefined,
  });

  const act = async <T,>(task: () => Promise<ActionResult<T>>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(task());
    setBusy(false);
    setError(res.ok ? null : res.error);
    if (res.ok) setNotice(success);
    list.reload();
  };

  const compare = async () => {
    setBusy(true);
    const res = await attempt(listRemoteEtimsItemsAction(branchId));
    setBusy(false);
    if (res.ok) {
      setRemote(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="eTIMS items" intro="Company items are used by every branch that does not act independently. A branch that acts independently registers and uses its own items." />

      <div className="max-w-md">
        <ChoicePicker
          label="Register items for"
          source="etims-targets"
          choice={chosen}
          onChoice={(c) => {
            setChosen(c ?? chosen);
            setRemote(null);
            setNotice(null);
            setError(null);
          }}
          clearable={false}
        />
      </div>

      {target !== undefined && !usable ? (
        <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700">
          eTIMS is not usable here: {target.reason}
        </p>
      ) : null}

      <div aria-live="polite">
        {has(error) ? (
          <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {has(notice) ? (
          <p role="status" className="text-sm text-emerald-700">
            {notice}
          </p>
        ) : null}
      </div>

      {usable ? (
        <>
          <EtimsRegisterForm key={key} scope={key} disabled={busy} onRegister={(input) => void act(() => registerEtimsItemAction(input), 'Item sent to KRA.')} />

          <section aria-label="Registered items" className="space-y-3">
            <div className="max-w-sm">
              <label htmlFor="etims-item-search" className="sr-only">
                Search registered items
              </label>
              <input id="etims-item-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by product or KRA code" className={fieldClass} autoComplete="off" />
            </div>
            {list.phase === 'error' ? (
              <p role="alert" className="text-sm text-red-700">
                {list.error}{' '}
                <button type="button" className={buttonClass} onClick={list.retry}>
                  Try again
                </button>
              </p>
            ) : null}
            {list.phase === 'loading' ? (
              <p role="status" className="text-sm text-fg-muted">
                Loading…
              </p>
            ) : null}
            {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-subtle">{query.trim() === '' ? 'No items registered here yet.' : `No item matches “${query.trim()}”.`}</p> : null}
            {list.rows.map((item) => (
              <EtimsItemCard
                key={item.id}
                item={item}
                disabled={busy}
                onStock={(quantity) => void act(() => updateEtimsStockAction({ branchId, productId: item.productId, quantity }), 'Stock updated at KRA.')}
                onResync={() => void act(() => updateEtimsItemAction({ branchId, productId: item.productId }), 'Item details re-sent to KRA.')}
                onReconcile={() => void act(() => reconcileEtimsItemAction({ branchId, productId: item.productId }), 'KRA item code found.')}
                onDelete={() => void act(() => removeEtimsItemAction({ branchId, productId: item.productId }), 'Item deleted at KRA.')}
              />
            ))}
            {list.cursor === null ? null : (
              <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
                {list.phase === 'more' ? 'Loading…' : 'Show more items'}
              </button>
            )}
          </section>

          <section aria-label="Items at KRA" className="space-y-3">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void compare()}>
              Compare with KRA
            </button>
            {remote === null ? null : <EtimsRemoteTable items={remote} />}
          </section>
        </>
      ) : null}
    </div>
  );
}
