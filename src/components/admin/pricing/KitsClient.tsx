'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewKitAction,
  removeKitAction,
  saveKitAction,
} from '@/server/domains/pricing/kit-actions';
import { KIT_ALLOCATIONS, type KitAllocation } from '@/server/domains/pricing/domain/kits';
import type { KitView } from '@/server/domains/pricing/kit-service';
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

const money = (n: number) =>
  n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Draft {
  productId: string;
  productLabel: string;
  allocation: KitAllocation;
  isActive: boolean;
  components: Array<{ productId: string; label: string; quantity: string; weight: string }>;
  editing: boolean;
  price: number | null;
}

export function KitsClient({ kits, canManage }: { kits: KitView[]; canManage: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<KitView | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState<
    Array<{ productId: string; name: string; quantity: number; amount: number; taxRate: number }>
  >([]);

  const parts = draft
    ? draft.components.map((c) => ({
        productId: c.productId,
        quantity: Math.trunc(Number(c.quantity)) || 0,
        weight: c.weight === '' ? null : Number(c.weight),
      }))
    : [];
  const signature = JSON.stringify([draft?.allocation, draft?.price, parts]);

  // Shows how today's price would be split, as the kit is set up.
  useEffect(() => {
    if (!draft || !draft.price || parts.length === 0 || parts.some((p) => p.quantity < 1)) {
      setSplit([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void previewKitAction({
        total: draft.price!,
        allocation: draft.allocation,
        components: parts,
      }).then((r) => live && setSplit(r.ok ? r.data : []));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // The signature stands for the whole setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const done = (text: string) => {
    setDraft(null);
    setRemoving(null);
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text });
    router.refresh();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    const r = await saveKitAction(
      {
        productId: draft.productId,
        allocation: draft.allocation,
        isActive: draft.isActive,
        components: parts,
      },
      reason,
    );
    setBusy(false);
    if (r.ok) done('Kit saved. It applies to the next sale.');
    else setMessage({ kind: 'error', text: r.error });
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const r = await removeKitAction(removing.productId, reason);
    setBusy(false);
    if (r.ok) done('It is an ordinary product again.');
    else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kits and hampers"
        actions={
          canManage && !draft ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setRemoving(null);
                setDraft({
                  productId: '',
                  productLabel: '',
                  allocation: 'list_price',
                  isActive: true,
                  components: [],
                  editing: false,
                  price: null,
                });
              }}
            >
              New kit
            </button>
          ) : null
        }
      >
        A kit is one product that is really several, such as a gift hamper. It is priced and
        discounted as one line. When the sale is saved it becomes a line for each component, each
        with its share of the price, so stock leaves per component, each is taxed at its own rate,
        and a return of one item credits the right amount.
      </PageHeader>
      <Notice message={message} />

      {draft ? (
        <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label="Kit">
          <ProductPick
            value={draft.productId ? draft.productLabel : ''}
            disabled={draft.editing}
            onPick={(p) =>
              setDraft({
                ...draft,
                productId: p.id,
                productLabel: `${p.name} (${p.sku})`,
              })
            }
            onClear={() => setDraft({ ...draft, productId: '', productLabel: '', price: null })}
          />
          <p className="-mt-2 text-xs text-fg-muted">
            The product people buy. Give it the price you want for the whole kit (in a price list or
            as its standard price). Its own stock is not used; the components&apos; is.
          </p>

          <div className="space-y-2">
            <p className={labelClass}>What is in it</p>
            {draft.components.map((c, i) => (
              <div
                key={c.productId}
                className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2"
              >
                <span className="min-w-40 flex-1 text-sm font-semibold text-fg-strong">
                  {c.label}
                </span>
                <div>
                  <label htmlFor={`${uid}-q${i}`} className="text-xs text-fg-muted">
                    Units in one kit
                  </label>
                  <input
                    id={`${uid}-q${i}`}
                    type="number"
                    min={1}
                    className={`${fieldClass} w-28`}
                    value={c.quantity}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        components: draft.components.map((x, n) =>
                          n === i ? { ...x, quantity: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </div>
                {draft.allocation === 'explicit' ? (
                  <div>
                    <label htmlFor={`${uid}-w${i}`} className="text-xs text-fg-muted">
                      Share of the price
                    </label>
                    <input
                      id={`${uid}-w${i}`}
                      type="number"
                      min={0}
                      step="0.01"
                      className={`${fieldClass} w-28`}
                      value={c.weight}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          components: draft.components.map((x, n) =>
                            n === i ? { ...x, weight: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </div>
                ) : null}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    setDraft({ ...draft, components: draft.components.filter((_, n) => n !== i) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <ProductPick
              value=""
              onPick={(p) =>
                draft.components.some((x) => x.productId === p.id)
                  ? undefined
                  : setDraft({
                      ...draft,
                      components: [
                        ...draft.components,
                        {
                          productId: p.id,
                          label: `${p.name} (${p.sku})`,
                          quantity: '1',
                          weight: '1',
                        },
                      ],
                    })
              }
              onClear={() => undefined}
            />
          </div>

          <div>
            <label htmlFor={`${uid}-alloc`} className={labelClass}>
              How the kit price is split between the components
            </label>
            <select
              id={`${uid}-alloc`}
              className={`${fieldClass} sm:max-w-md`}
              value={draft.allocation}
              onChange={(e) => setDraft({ ...draft, allocation: e.target.value as KitAllocation })}
            >
              {KIT_ALLOCATIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-fg-muted">
              {KIT_ALLOCATIONS.find((a) => a.value === draft.allocation)?.help}
            </p>
          </div>

          <div>
            <label htmlFor={`${uid}-try`} className={labelClass}>
              Try a kit price to see the split (optional)
            </label>
            <input
              id={`${uid}-try`}
              type="number"
              min={0}
              step="0.01"
              className={`${fieldClass} sm:max-w-xs`}
              value={draft.price ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, price: e.target.value ? Number(e.target.value) : null })
              }
            />
            {split.length > 0 ? (
              <ul
                role="status"
                className="mt-2 divide-y divide-line rounded-lg border border-line text-sm sm:max-w-md"
              >
                {split.map((p) => (
                  <li key={p.productId} className="flex justify-between gap-2 px-3 py-2">
                    <span>
                      {p.name}{' '}
                      <span className="text-fg-muted">
                        x{p.quantity}, tax {p.taxRate}%
                      </span>
                    </span>
                    <span className="font-mono">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.isActive}
              onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
            />
            In use (when off, it sells as an ordinary product)
          </label>

          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || !reason.code || !draft.productId || draft.components.length === 0}
            >
              {busy ? 'Saving…' : 'Save kit'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {removing ? (
        <section aria-label="Remove kit" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            Make <strong>{removing.productName}</strong> an ordinary product again? Orders already
            made keep their component lines.
          </p>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void remove()}
            >
              {busy ? 'Working…' : 'Remove the kit'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {kits.length === 0 ? (
        <EmptyState title="No kits yet">
          Make a product for the hamper, then turn it into a kit by listing what is in it.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {kits.map((k) => (
            <li key={k.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-fg-strong">
                    {k.productName}{' '}
                    <span className="text-xs font-normal text-fg-muted">{k.sku}</span>{' '}
                    {k.isActive ? null : <Chip tone="grey">Not in use</Chip>}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {k.price != null ? `Sells for ${money(k.price)}` : 'No selling price yet'} ·
                    components sold separately come to {money(k.componentsWorth)} ·{' '}
                    {k.buildable.toLocaleString()} can be made from stock
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-fg">
                    {k.components.map((c) => (
                      <li key={c.productId}>
                        {c.quantity} × {c.name}{' '}
                        <span className="text-xs text-fg-muted">
                          ({c.stock.toLocaleString()} in stock)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setRemoving(null);
                        setDraft({
                          productId: k.productId,
                          productLabel: `${k.productName} (${k.sku})`,
                          allocation: k.allocation,
                          isActive: k.isActive,
                          editing: true,
                          price: k.price,
                          components: k.components.map((c) => ({
                            productId: c.productId,
                            label: `${c.name} (${c.sku})`,
                            quantity: String(c.quantity),
                            weight: c.weight == null ? '1' : String(c.weight),
                          })),
                        });
                      }}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      className={`${buttonClass} text-red-700`}
                      onClick={() => {
                        setDraft(null);
                        setRemoving(k);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
