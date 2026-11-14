'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Minus, Plus, ShoppingCart, Zap } from 'lucide-react';
import { checkPackageLine, optionsToShow, type ShopOption, type ShopPackage, type ShopSlot } from '@/server/domains/pricing/domain/package-shop';
import { packageBuilderAction } from '@/server/domains/pricing/package-shop-actions';
import { MAX_SERVINGS, type PackagePick } from '@/lib/package-cart';

type Chosen = Record<string, Record<string, number>>;

/** The rule of a slot in words: "Choose 1", "Choose 1 to 2", "Choose up to 2 (optional)". */
export function slotRule(slot: Pick<ShopSlot, 'minPicks' | 'maxPicks' | 'included'>): string {
  if (slot.included) return 'Included';
  const { minPicks: min, maxPicks: max } = slot;
  if (min === 0) return `Choose up to ${String(max)} (optional)`;
  if (min === max) return `Choose ${String(min)}`;
  return `Choose ${String(min)} to ${String(max)}`;
}

/** What an option adds, in words the shopper reads on the card. */
export function optionPriceText(pkg: Pick<ShopPackage, 'pricingMode'>, option: Pick<ShopOption, 'difference' | 'price'>, money: (n: number) => string): string {
  if (pkg.pricingMode === 'summed') return option.price === null ? '' : money(option.price);
  if (option.difference === 0) return 'Included';
  return `${option.difference > 0 ? '+' : '−'} ${money(Math.abs(option.difference))}`;
}

const picksOf = (chosen: Chosen): PackagePick[] =>
  Object.entries(chosen).flatMap(([slotId, options]) => Object.entries(options).filter(([, count]) => count > 0).map(([optionId, count]) => ({ slotId, optionId, count })));
const without = (record: Record<string, number>, key: string): Record<string, number> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
const countIn = (chosen: Chosen, slotId: string): number => Object.values(chosen[slotId] ?? {}).reduce((n, c) => n + c, 0);

/** The choices to start from: an edited line's, or each slot's defaults that can be had (otherwise the first available option when the slot needs one). */
export function startingChoices(pkg: ShopPackage, available: ReadonlySet<string>, line?: { picks: readonly PackagePick[] }): Chosen {
  const chosen: Chosen = {};
  if (line !== undefined) {
    for (const pick of line.picks) chosen[pick.slotId] = { ...(chosen[pick.slotId] ?? {}), [pick.optionId]: pick.count };
    return chosen;
  }
  for (const slot of pkg.slots) {
    if (slot.included) continue;
    const defaults = slot.options.filter((o) => o.isDefault && available.has(o.id)).slice(0, slot.maxPicks);
    const picked = defaults.length === 0 && slot.minPicks > 0 ? slot.options.filter((o) => available.has(o.id)).slice(0, 1) : defaults;
    if (picked.length > 0) chosen[slot.id] = Object.fromEntries(picked.map((o) => [o.id, 1]));
  }
  return chosen;
}

interface Props {
  productName: string;
  builder: { package: ShopPackage; available: string[] };
  /** Opening on choices already made (editing a cart line or a quote line). */
  initial?: { picks: readonly PackagePick[]; servings: number; note?: string };
  money: (amount: number) => string;
  /** Takes the choices; returns the problem in words, or null when they were accepted. `intent` is `buy` for the second button. */
  onSubmit: (picks: PackagePick[], servings: number, intent: 'add' | 'buy', note: string) => Promise<string | null>;
  submitLabel?: string;
  /** The second button ("Buy now"); none when left out. */
  buyLabel?: string;
  /** Ask the server again what stock allows when the servings change (the shop does; a quote does not look at stock). */
  watchStock?: boolean;
  servingsLabel?: string;
}

/**
 * The step-by-step builder for a configurable package: one group of cards per slot, a live price and a button. One component for
 * the shop, the staff screens and the quote; the screen decides what pressing the button does. The server checks everything again.
 */
export function PackageBuilder({ productName, builder, initial, money, onSubmit, submitLabel = 'Add to cart', buyLabel, watchStock = true, servingsLabel = 'Servings' }: Props) {
  const pkg = builder.package;
  const [available, setAvailable] = useState<Set<string>>(() => new Set(builder.available));
  const [chosen, setChosen] = useState<Chosen>(() => startingChoices(pkg, new Set(builder.available), initial));
  const [servings, setServings] = useState(initial?.servings ?? 1);
  const [note, setNote] = useState(initial?.note ?? '');
  const noteId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // What stock allows depends on how many servings: ask again, quietly, a moment after the number changes.
  const asked = useRef(0);
  useEffect(() => {
    if (!watchStock || (servings === 1 && available.size === builder.available.length)) return;
    const ask = ++asked.current;
    const timer = window.setTimeout(() => {
      packageBuilderAction(pkg.productId, servings)
        .then((result) => {
          if (result.ok && result.data !== null && ask === asked.current) setAvailable(new Set(result.data.available));
        })
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of servings asks again
  }, [servings, pkg.productId, watchStock]);

  const picks = picksOf(chosen);
  // The same rules the server runs, over what is available now: options out of stock count as sold out, so the shopper hears why before pressing Add.
  const checked = useMemo(() => {
    const unlimited = new Set(pkg.slots.flatMap((s) => s.options.filter((o) => available.has(o.id)).map((o) => o.productId)));
    return checkPackageLine(pkg, { productId: pkg.productId, picks, servings, note: pkg.allowNote ? note : '' }, { free: new Map(), unlimited });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picks is derived from chosen
  }, [pkg, chosen, servings, available, note]);

  const toggle = (slot: ShopSlot, option: ShopOption) => {
    setProblem(null);
    setChosen((current) => {
      let mine = { ...(current[slot.id] ?? {}) };
      if (slot.maxPicks === 1) {
        // A single choice: picking another replaces it; picking the same again clears it when the slot is optional.
        if (mine[option.id] === 1) return slot.minPicks === 0 ? { ...current, [slot.id]: {} } : current;
        return { ...current, [slot.id]: { [option.id]: 1 } };
      }
      if ((mine[option.id] ?? 0) > 0) mine = without(mine, option.id);
      else if (countIn(current, slot.id) < slot.maxPicks) mine[option.id] = 1;
      return { ...current, [slot.id]: mine };
    });
    setAnnounce(`${option.name} changed`);
  };
  const step = (slot: ShopSlot, option: ShopOption, by: number) => {
    setProblem(null);
    setChosen((current) => {
      let mine = { ...(current[slot.id] ?? {}) };
      const next = (mine[option.id] ?? 0) + by;
      if (next <= 0) mine = without(mine, option.id);
      else if (by > 0 && countIn(current, slot.id) >= slot.maxPicks) return current;
      else mine[option.id] = next;
      return { ...current, [slot.id]: mine };
    });
  };

  const submit = async (intent: 'add' | 'buy') => {
    if (!checked.ok) return;
    setBusy(true);
    setProblem(null);
    const answer = await onSubmit(picks, servings, intent, pkg.allowNote ? note.trim() : '');
    setBusy(false);
    if (answer !== null) setProblem(answer);
  };

  const reason = checked.ok ? null : (checked.problems[0] ?? 'Choose your options.');
  return (
    <div className="space-y-5" data-testid="package-builder">
      {pkg.slots.map((slot) => {
        const shown = optionsToShow(slot, available, pkg.shortStockMode);
        const single = slot.maxPicks === 1;
        const selected = countIn(chosen, slot.id);
        const titleId = `slot-${slot.id}`;
        if (slot.included) {
          return (
            <section key={slot.id} aria-labelledby={titleId} className="rounded-xl border border-line bg-surface p-4">
              <h3 id={titleId} className="text-sm font-semibold text-fg-strong">{slot.name} <span className="font-normal text-fg-muted">· Included: {slot.options[0]?.name}</span></h3>
            </section>
          );
        }
        return (
          <section key={slot.id} aria-labelledby={titleId} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 id={titleId} className="text-sm font-semibold text-fg-strong">{slot.name}</h3>
              <p className="text-xs text-fg-muted">{slotRule(slot)}{single ? '' : ` · ${String(selected)} chosen`}</p>
            </div>
            {slot.helpText === '' ? null : <p className="text-xs text-fg-muted">{slot.helpText}</p>}
            {shown.length === 0 ? <p className="text-sm text-fg-muted">Nothing is available to choose right now.</p> : null}
            <div role={single ? 'radiogroup' : 'group'} aria-labelledby={titleId} className="grid gap-2 sm:grid-cols-2">
              {shown.map(({ option, available: can, suggestion }) => {
                const count = chosen[slot.id]?.[option.id] ?? 0;
                const on = count > 0;
                const swap = suggestion === null ? null : slot.options.find((o) => o.id === suggestion);
                const full = !single && !on && selected >= slot.maxPicks;
                return (
                  <div key={option.id} className={`flex min-h-12 items-center gap-2 rounded-xl border p-2 ${on ? 'border-indigo-500 bg-indigo-500/10' : 'border-line bg-surface'} ${can ? '' : 'opacity-60'}`}>
                    <button
                      type="button"
                      role={single ? 'radio' : 'checkbox'}
                      aria-checked={on}
                      disabled={!can || (full && !on)}
                      onClick={() => toggle(slot, option)}
                      className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 text-left disabled:cursor-not-allowed"
                    >
                      <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center border ${single ? 'rounded-full' : 'rounded'} ${on ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-line-strong'}`}>
                        {on ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-fg-strong">{option.name}</span>
                        <span className="block text-xs text-fg-muted">{can ? optionPriceText(pkg, option, money) : 'Sold out today'}</span>
                      </span>
                    </button>
                    {can && !single && slot.allowRepeats && on ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button type="button" aria-label={`One less ${option.name}`} onClick={() => step(slot, option, -1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover"><Minus className="h-4 w-4" aria-hidden="true" /></button>
                        <span className="w-6 text-center text-sm font-semibold" aria-label={`${String(count)} ${option.name}`}>{count}</span>
                        <button type="button" aria-label={`One more ${option.name}`} disabled={selected >= slot.maxPicks} onClick={() => step(slot, option, 1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" /></button>
                      </span>
                    ) : null}
                    {!can && swap !== null && swap !== undefined ? (
                      <button type="button" onClick={() => toggle(slot, swap)} className="min-h-10 shrink-0 cursor-pointer rounded-lg px-2 text-xs font-semibold text-indigo-400 hover:underline">Try {swap.name}</button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg-muted">{servingsLabel}</span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label="One less serving" disabled={servings <= 1} onClick={() => setServings(servings - 1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><Minus className="h-4 w-4" aria-hidden="true" /></button>
          <span className="w-10 text-center text-sm font-semibold" aria-label={`${String(servings)} servings`}>{servings}</span>
          <button type="button" aria-label="One more serving" disabled={servings >= MAX_SERVINGS} onClick={() => setServings(servings + 1)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" /></button>
        </span>
      </div>

      {pkg.allowNote ? (
        <div className="space-y-1">
          <label htmlFor={noteId} className="text-sm font-medium text-fg-muted">Note for each serving (optional)</label>
          <textarea id={noteId} rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: no pepper" className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong" />
          <p className="text-xs text-fg-muted">{note.length} of 200 characters</p>
        </div>
      ) : null}

      <div className="rounded-xl border border-line bg-surface p-4" aria-live="polite">
        {checked.ok ? (
          <>
            <p className="text-lg font-bold text-fg-strong" data-testid="package-total">{money(checked.total)}</p>
            <p className="text-xs text-fg-muted">{servings === 1 ? productName : `${money(checked.servingPrice)} each for ${String(servings)}`}</p>
          </>
        ) : (
          <p className="text-sm text-fg-muted" data-testid="package-reason">{reason}</p>
        )}
      </div>
      <p className="sr-only" role="status">{announce}</p>
      {problem === null ? null : <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{problem}</p>}

      <div className={`grid grid-cols-1 gap-2 ${buyLabel === undefined ? '' : 'min-[420px]:grid-cols-2'}`}>
        <button
          type="button"
          disabled={!checked.ok || busy}
          onClick={() => void submit('add')}
          className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface-sunken px-4 py-2.5 text-sm font-semibold text-fg-strong transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShoppingCart className="h-4 w-4 text-indigo-400" aria-hidden="true" />
          {submitLabel}
        </button>
        {buyLabel !== undefined ? (
          <button
            type="button"
            disabled={!checked.ok || busy}
            onClick={() => void submit('buy')}
            className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap className="h-4 w-4" aria-hidden="true" />
            {buyLabel}
          </button>
        ) : null}
      </div>
      {checked.ok || reason === null ? null : <p className="text-xs text-fg-muted">{submitLabel} is off: {reason}</p>}
    </div>
  );
}
