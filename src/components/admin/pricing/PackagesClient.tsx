'use client';

import { use, useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { packagesScreenAction, removePackageAction, savePackageAction } from '@/server/domains/pricing/package-actions';
import type { PackageView } from '@/server/domains/pricing/package-service';
import { CATEGORY_SLOT_LIMIT, PACKAGE_SLOT_SOURCE_CHOICES, labelOfPackageChoice, minutesOfTime, PACKAGE_AUDIENCE_CHOICES, PACKAGE_PRICING_CHOICES, PACKAGE_SHORT_STOCK_CHOICES, PACKAGE_SPLIT_CHOICES, rulesWords, timeOfMinutes, WEEKDAY_NAMES } from '@/lib/package-choices';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import type { Choice } from '@/lib/payment-options';

type Loaded = Awaited<ReturnType<typeof packagesScreenAction>>;

const money = (n: number): string => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface OptionDraft {
  key: string;
  choice: Choice | null;
  quantity: string;
  difference: string;
  ownPrice: string;
  isDefault: boolean;
  weight: string;
}
interface SlotDraft {
  key: string;
  name: string;
  helpText: string;
  minPicks: string;
  maxPicks: string;
  allowRepeats: boolean;
  included: boolean;
  /** Where the options come from: a list made by hand, or every product of a category. */
  source: string;
  category: Choice | null;
  categoryDifference: string;
  categoryOwnPrice: string;
  categoryQuantity: string;
  options: OptionDraft[];
}
interface Draft {
  editing: boolean;
  product: Choice | null;
  pricingMode: string;
  allocation: string;
  shortStockMode: string;
  isActive: boolean;
  allowNote: boolean;
  /** The rules of ordering, as typed (empty = no rule). Notice is in hours, closing time as HH:MM. */
  minServings: string;
  maxServings: string;
  noticeHours: string;
  closesDaysBefore: string;
  closesAt: string;
  weekdays: number[];
  dailyLimit: string;
  audience: string;
  groups: Choice[];
  slots: SlotDraft[];
}

const newKey = (): string => globalThis.crypto.randomUUID();
const blankOption = (): OptionDraft => ({ key: newKey(), choice: null, quantity: '1', difference: '0', ownPrice: '', isDefault: false, weight: '' });
const blankSlot = (): SlotDraft => ({ key: newKey(), name: '', helpText: '', minPicks: '1', maxPicks: '1', allowRepeats: false, included: false, source: 'list', category: null, categoryDifference: '0', categoryOwnPrice: '', categoryQuantity: '1', options: [blankOption()] });
const blankDraft = (): Draft => ({ editing: false, product: null, pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide', isActive: true, allowNote: false, minServings: '', maxServings: '', noticeHours: '', closesDaysBefore: '', closesAt: '', weekdays: [], dailyLimit: '', audience: 'anyone', groups: [], slots: [blankSlot()] });

const draftOf = (pkg: PackageView): Draft => ({
  editing: true,
  product: { id: pkg.productId, label: pkg.productName },
  pricingMode: pkg.pricingMode,
  allocation: pkg.allocation,
  shortStockMode: pkg.shortStockMode,
  isActive: pkg.isActive,
  allowNote: pkg.allowNote,
  minServings: pkg.rules.minServings === null ? '' : String(pkg.rules.minServings),
  maxServings: pkg.rules.maxServings === null ? '' : String(pkg.rules.maxServings),
  noticeHours: pkg.rules.noticeMinutes === null ? '' : String(pkg.rules.noticeMinutes / 60),
  closesDaysBefore: pkg.rules.closesDaysBefore === null ? '' : String(pkg.rules.closesDaysBefore),
  closesAt: pkg.rules.closesAtMinute === null ? '' : timeOfMinutes(pkg.rules.closesAtMinute),
  weekdays: pkg.rules.weekdays,
  dailyLimit: pkg.rules.dailyLimit === null ? '' : String(pkg.rules.dailyLimit),
  audience: pkg.rules.audience,
  groups: pkg.rules.groupIds.map((id) => ({ id, label: pkg.rules.groupLabels?.[id] ?? 'Customer group' })),
  slots: pkg.slots.map((slot) => ({
    key: slot.id,
    name: slot.name,
    helpText: slot.helpText,
    minPicks: String(slot.minPicks),
    maxPicks: String(slot.maxPicks),
    allowRepeats: slot.allowRepeats,
    included: slot.included,
    source: slot.source,
    category: slot.categoryId === null ? null : { id: slot.categoryId, label: slot.categoryName },
    categoryDifference: String(slot.categoryDifference),
    categoryOwnPrice: slot.categoryOwnPrice === null ? '' : String(slot.categoryOwnPrice),
    categoryQuantity: String(slot.categoryQuantity),
    options: slot.source === 'category' ? [] : slot.options.map((o) => ({ key: o.id, choice: { id: o.productId, label: o.name }, quantity: String(o.quantity), difference: String(o.difference), ownPrice: o.ownPrice === null ? '' : String(o.ownPrice), isDefault: o.isDefault, weight: o.weight === null ? '' : String(o.weight) })),
  })),
});

function picksWords(slot: { included: boolean; minPicks: number; maxPicks: number }): string {
  if (slot.included) return 'included';
  if (slot.minPicks === slot.maxPicks) return `pick ${String(slot.maxPicks)}`;
  return `pick ${String(slot.minPicks)} to ${String(slot.maxPicks)}`;
}

const optional = (value: string): number | null => (value.trim() === '' ? null : Number(value));

function payloadOf(draft: Draft): unknown {
  return {
    productId: draft.product?.id ?? '',
    pricingMode: draft.pricingMode,
    allocation: draft.allocation,
    shortStockMode: draft.shortStockMode,
    isActive: draft.isActive,
    allowNote: draft.allowNote,
    rules: {
      minServings: optional(draft.minServings),
      maxServings: optional(draft.maxServings),
      noticeMinutes: draft.noticeHours.trim() === '' ? null : Math.round(Number(draft.noticeHours) * 60),
      closesDaysBefore: optional(draft.closesDaysBefore),
      closesAtMinute: minutesOfTime(draft.closesAt),
      weekdays: draft.weekdays,
      dailyLimit: optional(draft.dailyLimit),
      audience: draft.audience,
      groupIds: draft.groups.map((g) => g.id),
    },
    slots: draft.slots.map((slot) => ({
      name: slot.name,
      helpText: slot.helpText,
      minPicks: Number(slot.minPicks),
      maxPicks: Number(slot.maxPicks),
      allowRepeats: slot.allowRepeats,
      included: slot.included,
      source: slot.source,
      categoryId: slot.category?.id ?? null,
      categoryDifference: Number(slot.categoryDifference === '' ? '0' : slot.categoryDifference),
      categoryOwnPrice: optional(slot.categoryOwnPrice),
      categoryQuantity: Number(slot.categoryQuantity === '' ? '1' : slot.categoryQuantity),
      options: slot.options.map((o) => ({ productId: o.choice?.id ?? '', quantity: Number(o.quantity), difference: Number(o.difference === '' ? '0' : o.difference), ownPrice: optional(o.ownPrice), isDefault: o.isDefault, weight: optional(o.weight) })),
    })),
  };
}

const move = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
};

export function PackagesClient({ initialPromise }: { initialPromise: ReturnType<typeof packagesScreenAction> }) {
  const res: Loaded = use(initialPromise);
  return res.ok ? <Body initial={res.data.packages} canManage={res.data.canManage} /> : <LoadFailed error={res.error} />;
}

function Body({ initial, canManage }: { initial: PackageView[]; canManage: boolean }) {
  const [list, setList] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const reload = async (text: string) => {
    const r = await attempt(packagesScreenAction());
    if (r.ok) {
      setList(r.data.packages);
      setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Packages"
        intro="A package is one product made of choices, such as a lunch with a fish, a starch and vegetables the shopper picks. Each choice is a slot; each slot offers options from your stock. Parts that nobody should buy alone can be marked as sold only inside packages on their product."
        actions={canManage && draft === null ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setDraft(blankDraft()); }}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />New package</button> : undefined}
      />
      <Message notice={notice} />
      {draft === null ? null : (
        <Editor
          key={draft.product?.id ?? 'new'}
          initial={draft}
          onCancel={() => setDraft(null)}
          onSaved={(text) => {
            setDraft(null);
            void reload(text);
          }}
        />
      )}
      <section aria-label="Packages" className="space-y-3">
        {list.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No package yet. {canManage ? 'Choose New package to make the first one.' : 'Someone who may change pricing can make one.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {list.map((pkg) => (
              <li key={pkg.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-fg-strong">{pkg.productName}</h3>
                    <p className="text-xs text-fg-muted">{pkg.sku}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone={pkg.isActive ? 'green' : 'gray'}>{pkg.isActive ? 'In use' : 'Not in use'}</Chip>
                    <Chip tone="sky">{pkg.pricingMode === 'summed' ? 'Options added up' : 'Base price + differences'}</Chip>
                    {pkg.from.price === null ? <Chip tone="amber">No price yet</Chip> : <Chip tone="gray">From {money(pkg.from.price)}</Chip>}
                    {rulesWords(pkg.rules).map((w) => <Chip key={w} tone="sky">{w}</Chip>)}
                    {pkg.from.belowCost ? <Chip tone="red">Cheapest choice sells below cost</Chip> : null}
                    {pkg.unavailableOptions > 0 ? <Chip tone="amber">{pkg.unavailableOptions} option{pkg.unavailableOptions === 1 ? '' : 's'} cannot be chosen</Chip> : null}
                  </div>
                </div>
                <ul className="mt-3 space-y-1 text-sm text-fg">
                  {pkg.slots.map((slot) => (
                    <li key={slot.id}>
                      <span className="font-semibold">{slot.name}</span>
                      <span className="text-fg-muted">: {picksWords(slot)} from {slot.source === 'category' ? `every product of ${slot.categoryName} (${String(slot.options.length)} now)` : slot.options.map((o) => o.name).join(', ')}</span>
                    </li>
                  ))}
                </ul>
                {canManage ? (
                  <div className="mt-3">
                    <button type="button" className={buttonClass} aria-label={`Change ${pkg.productName}`} onClick={() => { setNotice(null); setDraft(draftOf(pkg)); }}>Change</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Editor({ initial, onCancel, onSaved }: { initial: Draft; onCancel: () => void; onSaved: (text: string) => void }) {
  const uid = useId();
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const setSlot = (key: string, changes: Partial<SlotDraft>) => setDraft((d) => ({ ...d, slots: d.slots.map((s) => (s.key === key ? { ...s, ...changes } : s)) }));
  const setOption = (slotKey: string, key: string, changes: Partial<OptionDraft>) =>
    setDraft((d) => ({ ...d, slots: d.slots.map((s) => (s.key === slotKey ? { ...s, options: s.options.map((o) => (o.key === key ? { ...o, ...changes } : o)) } : s)) }));
  const summed = draft.pricingMode === 'summed';
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(savePackageAction(payloadOf(draft), reason));
    setBusy(false);
    if (r.ok) onSaved(draft.editing ? 'Package saved. It applies to the next order.' : 'Package made. It applies to the next order.');
    else setProblem(r.error);
  };
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(removePackageAction(draft.product?.id ?? '', reason));
    setBusy(false);
    if (r.ok) onSaved('Package removed. The product is an ordinary product again.');
    else setProblem(r.error);
  };
  return (
    <form
      aria-label={draft.editing ? 'Change package' : 'New package'}
      className={`${cardClass} space-y-4`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">{draft.editing ? `Change ${draft.product?.label ?? 'package'}` : 'New package'}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {draft.editing ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-fg">Product sold as the package</p>
            <p className="min-h-10 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-fg-strong">{draft.product?.label}</p>
          </div>
        ) : (
          <ChoicePicker label="Product sold as the package" source="package-products" choice={draft.product} onChoice={(c) => setDraft((d) => ({ ...d, product: c }))} placeholder="Search products…" required />
        )}
        <ChoicePicker label="How the package is priced" source="package-pricing-modes" clearable={false} choice={{ id: draft.pricingMode, label: labelOfPackageChoice(PACKAGE_PRICING_CHOICES, draft.pricingMode) }} onChoice={(c) => c !== null && setDraft((d) => ({ ...d, pricingMode: c.id }))} />
        <ChoicePicker label="How the price is split over the parts" source="package-split-methods" clearable={false} choice={{ id: draft.allocation, label: labelOfPackageChoice(PACKAGE_SPLIT_CHOICES, draft.allocation) }} onChoice={(c) => c !== null && setDraft((d) => ({ ...d, allocation: c.id }))} />
        <ChoicePicker label="An option that is out of stock" source="package-short-stock-modes" clearable={false} choice={{ id: draft.shortStockMode, label: labelOfPackageChoice(PACKAGE_SHORT_STOCK_CHOICES, draft.shortStockMode) }} onChoice={(c) => c !== null && setDraft((d) => ({ ...d, shortStockMode: c.id }))} />
      </div>
      <p className="text-xs text-fg-muted">
        {summed ? 'Each option is priced on its own (the product\'s selling price, or a fixed price you give here) and the serving costs the sum. The package product\'s own price is not charged.' : 'The package product\'s own price is the base price. Each option can add to it or take from it with a difference.'}
      </p>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={draft.isActive} onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))} />
        In use (when off, the product sells as an ordinary product)
      </label>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={draft.allowNote} onChange={(e) => setDraft((d) => ({ ...d, allowNote: e.target.checked }))} />
        Customers can write a note on each serving (for example &quot;no pepper&quot;); it is kept with the order and shown on the preparation sheet
      </label>

      <fieldset className="space-y-3 rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-bold tracking-wider text-fg-subtle uppercase">Rules of ordering (leave empty for no rule)</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field id={`${uid}-min`} label="Fewest servings per order"><input id={`${uid}-min`} inputMode="numeric" className={fieldClass} value={draft.minServings} onChange={(e) => setDraft((d) => ({ ...d, minServings: e.target.value }))} /></Field>
          <Field id={`${uid}-max`} label="Most servings per order"><input id={`${uid}-max`} inputMode="numeric" className={fieldClass} value={draft.maxServings} onChange={(e) => setDraft((d) => ({ ...d, maxServings: e.target.value }))} /></Field>
          <Field id={`${uid}-daily`} label="Most servings promised for one day"><input id={`${uid}-daily`} inputMode="numeric" className={fieldClass} value={draft.dailyLimit} onChange={(e) => setDraft((d) => ({ ...d, dailyLimit: e.target.value }))} /></Field>
          <Field id={`${uid}-notice`} label="Notice needed (hours)"><input id={`${uid}-notice`} inputMode="decimal" className={fieldClass} value={draft.noticeHours} onChange={(e) => setDraft((d) => ({ ...d, noticeHours: e.target.value }))} /></Field>
          <Field id={`${uid}-closes-days`} label="Ordering closes (days before)"><input id={`${uid}-closes-days`} inputMode="numeric" className={fieldClass} value={draft.closesDaysBefore} onChange={(e) => setDraft((d) => ({ ...d, closesDaysBefore: e.target.value }))} /></Field>
          <Field id={`${uid}-closes-at`} label="Ordering closes at (time of day)"><input id={`${uid}-closes-at`} type="time" className={fieldClass} value={draft.closesAt} onChange={(e) => setDraft((d) => ({ ...d, closesAt: e.target.value }))} /></Field>
        </div>
        <div role="group" aria-label="Days it can be served" className="flex flex-wrap gap-x-4 gap-y-1">
          {WEEKDAY_NAMES.map((name, day) => (
            <label key={name} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={draft.weekdays.includes(day)} onChange={(e) => setDraft((d) => ({ ...d, weekdays: e.target.checked ? [...d.weekdays, day].sort((a, b) => a - b) : d.weekdays.filter((x) => x !== day) }))} />
              {name}
            </label>
          ))}
          <span className="text-xs text-fg-muted">None ticked means every day. Dates are counted in the company&apos;s time.</span>
        </div>
        <ChoicePicker label="Who may order" source="package-audiences" clearable={false} choice={{ id: draft.audience, label: labelOfPackageChoice(PACKAGE_AUDIENCE_CHOICES, draft.audience) }} onChoice={(c) => c !== null && setDraft((d) => ({ ...d, audience: c.id }))} />
        {draft.audience === 'groups' ? (
          <div className="space-y-2">
            <ChoicePicker label="Add a customer group" source="package-customer-groups" choice={null} onChoice={(c) => c !== null && setDraft((d) => (d.groups.some((g) => g.id === c.id) ? d : { ...d, groups: [...d.groups, c] }))} placeholder="Search groups…" />
            <ul className="flex flex-wrap gap-2" aria-label="Customer groups that may order">
              {draft.groups.map((g) => (
                <li key={g.id} className="flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm">
                  {g.label}
                  <button type="button" aria-label={`Remove ${g.label}`} className="flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-hover" onClick={() => setDraft((d) => ({ ...d, groups: d.groups.filter((x) => x.id !== g.id) }))}>×</button>
                </li>
              ))}
              {draft.groups.length === 0 ? <li className="text-xs text-fg-muted">No group chosen yet.</li> : null}
            </ul>
          </div>
        ) : null}
      </fieldset>

      <div className="space-y-3">
        {draft.slots.map((slot, si) => (
          <fieldset key={slot.key} className="space-y-3 rounded-lg border border-line p-3">
            <legend className="px-1 text-xs font-bold tracking-wider text-fg-subtle uppercase">Slot {si + 1}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2"><Field id={`${uid}-n-${slot.key}`} label={`Name of slot ${String(si + 1)}`}><input id={`${uid}-n-${slot.key}`} className={fieldClass} value={slot.name} maxLength={80} placeholder="Fish" onChange={(e) => setSlot(slot.key, { name: e.target.value })} /></Field></div>
              <Field id={`${uid}-min-${slot.key}`} label={`Fewest picks, slot ${String(si + 1)}`}><input id={`${uid}-min-${slot.key}`} className={fieldClass} inputMode="numeric" value={slot.minPicks} onChange={(e) => setSlot(slot.key, { minPicks: e.target.value })} /></Field>
              <Field id={`${uid}-max-${slot.key}`} label={`Most picks, slot ${String(si + 1)}`}><input id={`${uid}-max-${slot.key}`} className={fieldClass} inputMode="numeric" value={slot.maxPicks} onChange={(e) => setSlot(slot.key, { maxPicks: e.target.value })} /></Field>
            </div>
            <Field id={`${uid}-h-${slot.key}`} label={`Help text, slot ${String(si + 1)} (optional)`} hint="Shown to the shopper under the slot's name."><input id={`${uid}-h-${slot.key}`} className={fieldClass} value={slot.helpText} maxLength={200} onChange={(e) => setSlot(slot.key, { helpText: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={slot.allowRepeats} onChange={(e) => setSlot(slot.key, { allowRepeats: e.target.checked })} />The same option can be chosen more than once</label>
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={slot.included} onChange={(e) => setSlot(slot.key, { included: e.target.checked, ...(e.target.checked ? { minPicks: '1', maxPicks: '1' } : {}) })} />Included, not a choice (one option, always part of it)</label>
            </div>
            <ChoicePicker label={`Where the options of slot ${String(si + 1)} come from`} source="package-slot-sources" clearable={false} choice={{ id: slot.source, label: labelOfPackageChoice(PACKAGE_SLOT_SOURCE_CHOICES, slot.source) }} onChoice={(c) => c !== null && setSlot(slot.key, { source: c.id, ...(c.id === 'category' && slot.included ? { included: false } : {}) })} />
            {slot.source === 'category' ? (
              <div className="grid grid-cols-1 items-end gap-3 rounded-lg border border-line bg-surface-sunken p-3 sm:grid-cols-4">
                <div className="sm:col-span-2"><ChoicePicker label={`Category, slot ${String(si + 1)}`} source="package-categories" choice={slot.category} onChoice={(c) => setSlot(slot.key, { category: c })} placeholder="Search categories…" required /></div>
                <Field id={`${uid}-cq-${slot.key}`} label={`Quantity of each pick, slot ${String(si + 1)}`}><input id={`${uid}-cq-${slot.key}`} className={fieldClass} inputMode="decimal" value={slot.categoryQuantity} onChange={(e) => setSlot(slot.key, { categoryQuantity: e.target.value })} /></Field>
                {summed ? (
                  <Field id={`${uid}-cp-${slot.key}`} label={`Fixed price of each pick, slot ${String(si + 1)}`} hint="Empty: each product's selling price."><input id={`${uid}-cp-${slot.key}`} className={fieldClass} inputMode="decimal" value={slot.categoryOwnPrice} onChange={(e) => setSlot(slot.key, { categoryOwnPrice: e.target.value })} /></Field>
                ) : (
                  <Field id={`${uid}-cd-${slot.key}`} label={`Difference of each pick, slot ${String(si + 1)}`} hint="Added to the base price."><input id={`${uid}-cd-${slot.key}`} className={fieldClass} inputMode="decimal" value={slot.categoryDifference} onChange={(e) => setSlot(slot.key, { categoryDifference: e.target.value })} /></Field>
                )}
                <p className="text-xs text-fg-muted sm:col-span-4">Every product of the category that can be sold, is switched on and is not a kit or a package is offered (up to {CATEGORY_SLOT_LIMIT}, by name), so a new product added to the category shows up on its own.</p>
              </div>
            ) : (
            <>
            <ul className="space-y-2">
              {slot.options.map((option, oi) => (
                <li key={option.key} className="grid grid-cols-1 items-end gap-2 rounded-lg border border-line bg-surface-sunken p-3 sm:grid-cols-6">
                  <div className="sm:col-span-2">
                    <ChoicePicker label={`Product, slot ${String(si + 1)} option ${String(oi + 1)}`} source="package-option-products" choice={option.choice} onChoice={(c) => setOption(slot.key, option.key, { choice: c })} placeholder="Search products…" required />
                  </div>
                  <Field id={`${uid}-q-${option.key}`} label={`Quantity, slot ${String(si + 1)} option ${String(oi + 1)}`}><input id={`${uid}-q-${option.key}`} className={fieldClass} inputMode="decimal" value={option.quantity} onChange={(e) => setOption(slot.key, option.key, { quantity: e.target.value })} /></Field>
                  {summed ? (
                    <Field id={`${uid}-p-${option.key}`} label={`Fixed price, slot ${String(si + 1)} option ${String(oi + 1)}`} hint="Empty: the product's selling price."><input id={`${uid}-p-${option.key}`} className={fieldClass} inputMode="decimal" value={option.ownPrice} onChange={(e) => setOption(slot.key, option.key, { ownPrice: e.target.value })} /></Field>
                  ) : (
                    <Field id={`${uid}-d-${option.key}`} label={`Difference, slot ${String(si + 1)} option ${String(oi + 1)}`} hint="Added to the base price."><input id={`${uid}-d-${option.key}`} className={fieldClass} inputMode="decimal" value={option.difference} onChange={(e) => setOption(slot.key, option.key, { difference: e.target.value })} /></Field>
                  )}
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={option.isDefault} onChange={(e) => setOption(slot.key, option.key, { isDefault: e.target.checked })} />Pre-selected</label>
                  <button type="button" className={buttonClass} aria-label={`Remove option ${String(oi + 1)} of slot ${String(si + 1)}`} disabled={slot.options.length === 1} onClick={() => setSlot(slot.key, { options: slot.options.filter((o) => o.key !== option.key) })}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                  {draft.allocation === 'explicit' ? (
                    <div className="sm:col-span-2"><Field id={`${uid}-w-${option.key}`} label={`Share, slot ${String(si + 1)} option ${String(oi + 1)}`} hint="For the split by shares you set."><input id={`${uid}-w-${option.key}`} className={fieldClass} inputMode="decimal" value={option.weight} onChange={(e) => setOption(slot.key, option.key, { weight: e.target.value })} /></Field></div>
                  ) : null}
                </li>
              ))}
            </ul>
            </>
            )}
            <div className="flex flex-wrap gap-2">
              {slot.source === 'list' ? <button type="button" className={buttonClass} disabled={slot.included} onClick={() => setSlot(slot.key, { options: [...slot.options, blankOption()] })}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add an option</button> : null}
              <button type="button" className={buttonClass} aria-label={`Move slot ${String(si + 1)} up`} disabled={si === 0} onClick={() => setDraft((d) => ({ ...d, slots: move(d.slots, si, si - 1) }))}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={buttonClass} aria-label={`Move slot ${String(si + 1)} down`} disabled={si === draft.slots.length - 1} onClick={() => setDraft((d) => ({ ...d, slots: move(d.slots, si, si + 1) }))}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={buttonClass} aria-label={`Remove slot ${String(si + 1)}`} disabled={draft.slots.length === 1} onClick={() => setDraft((d) => ({ ...d, slots: d.slots.filter((s) => s.key !== slot.key) }))}><Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />Remove slot</button>
            </div>
          </fieldset>
        ))}
        <button type="button" className={buttonClass} onClick={() => setDraft((d) => ({ ...d, slots: [...d.slots, blankSlot()] }))}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add a slot</button>
      </div>

      <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
      <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryClass} disabled={busy || reason.code === '' || draft.product === null}>{busy ? 'Saving…' : 'Save package'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {draft.editing ? <InlineConfirm label={`Remove the package ${draft.product?.label ?? ''}`} action="Remove package" confirm="Yes, remove it" busy={busy || reason.code === ''} onConfirm={() => void remove()} /> : null}
      </div>
      {draft.editing && reason.code === '' ? <p className="text-xs text-fg-muted">Choose a reason to save or remove.</p> : null}
    </form>
  );
}
