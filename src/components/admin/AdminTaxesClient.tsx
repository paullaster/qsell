'use client';

import { use, useId, useState } from 'react';
import { deleteTaxCategoryAction, setDefaultTaxCategoryAction, taxCategoriesPageAction, taxSummaryAction } from '@/server/domains/taxes/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, Chip, cardClass, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { breakdown, isPricingModel, isTaxType, labelOfTaxType, type PricingModel } from '@/lib/tax-forms';
import type { Choice } from '@/lib/payment-options';
import type { TaxCategory, TaxType } from '@/types/index';
import { TaxCategoryForm } from './TaxCategoryForm';

type FirstPage = Extract<Awaited<ReturnType<typeof taxCategoriesPageAction>>, { ok: true }>;
type Summary = Extract<Awaited<ReturnType<typeof taxSummaryAction>>, { ok: true }>['data'];

interface Props {
  firstPage: ReturnType<typeof taxCategoriesPageAction>;
  summary: ReturnType<typeof taxSummaryAction>;
}

export function AdminTaxesClient({ firstPage, summary }: Props) {
  const first = use(firstPage);
  const totals = use(summary);
  if (!first.ok) return <LoadFailed error={first.error} />;
  if (!totals.ok) return <LoadFailed error={totals.error} />;
  return <Taxes first={first} initialSummary={totals.data} />;
}

function Taxes({ first, initialSummary }: { first: FirstPage; initialSummary: Summary }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<Choice | null>(null);
  const [pricing, setPricing] = useState<Choice | null>(null);
  const [summary, setSummary] = useState(initialSummary);
  const [editing, setEditing] = useState<TaxCategory | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const typeFilter: TaxType | undefined = isTaxType(type?.id) ? type.id : undefined;
  const pricingFilter: PricingModel | undefined = isPricingModel(pricing?.id) ? pricing.id : undefined;
  const list = usePagedList<TaxCategory, { query: string; type: TaxType | undefined; pricing: PricingModel | undefined }>({
    load: (filters, cursor) => taxCategoriesPageAction({ query: filters.query, type: filters.type, inclusive: filters.pricing === undefined ? undefined : filters.pricing === 'inclusive', cursor }),
    filters: { query: query.trim(), type: typeFilter, pricing: pricingFilter },
    initialPage: first,
  });

  const refreshed = async () => {
    const fresh = await attempt(taxSummaryAction());
    if (fresh.ok) setSummary(fresh.data);
    list.reload();
  };
  const finish = async (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) await refreshed();
  };
  const makeDefault = async (t: TaxCategory) => {
    setBusy(true);
    const res = await attempt(setDefaultTaxCategoryAction(t.id));
    await finish(res.ok, res.ok ? `${t.name} is now the default.` : res.error);
  };
  const remove = async (t: TaxCategory) => {
    setBusy(true);
    const res = await attempt(deleteTaxCategoryAction(t.id));
    await finish(res.ok, res.ok ? `${t.name} deleted. Products that used it were reassigned.` : res.error);
  };

  const def = summary.defaultRule;
  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title="Tax & compliance management"
        intro="Define tax rules for catalog pricing and checkout. Add only the schedules your business uses."
        actions={
          <button type="button" className={primaryClass} onClick={() => setEditing('new')}>
            Add tax rule
          </button>
        }
      />
      <Message notice={notice} />

      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Default fiscal rate" value={def === null ? '—' : `${String(def.rate)}%`} note={def?.name ?? 'No default set'} />
        <Card title="Active tax schedules" value={String(summary.active)} note={`of ${String(summary.total)} rules`} />
        <Card title="Price display model" value={pricingWords(def)} note="From the default tax rule, when set" />
        <Card title="Jurisdictions" value={String(summary.countries)} note="country codes" />
      </section>

      {editing === null ? null : (
        <div className={`${cardClass} max-w-xl`}>
          <h3 className="mb-3 text-base font-bold text-fg-strong">{editing === 'new' ? 'Create tax schedule & category' : 'Edit tax schedule'}</h3>
          <TaxCategoryForm
            key={editing === 'new' ? 'new' : editing.id}
            tax={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              void finish(true, `${saved.name} saved.`);
            }}
          />
        </div>
      )}

      {summary.total > 0 ? <Calculator defaultRule={def} /> : null}

      <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_16rem_14rem]">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search tax rules
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, code or country…" className={fieldClass} autoComplete="off" />
        </div>
        <ChoicePicker label="Tax type" source="tax-types" choice={type} onChoice={setType} placeholder="All tax types" />
        <ChoicePicker label="Pricing model" source="tax-pricing-models" choice={pricing} onChoice={setPricing} placeholder="All pricing models" />
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
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-subtle">{summary.total === 0 ? 'No tax rules yet. Use “Add tax rule” to create one.' : 'No tax rules match your filters.'}</p> : null}

      <ul className="space-y-2" aria-label="Tax rules">
        {list.rows.map((t) => (
          <li key={t.id} className="rounded-xl border border-line bg-surface-raised p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-strong">
                  {t.name} <span className="font-mono text-xs font-normal text-fg-muted">{t.code}</span>
                  {t.isDefault ? <Chip tone="amber">Default</Chip> : null}
                  <Chip tone={t.isActive ? 'green' : 'gray'}>{t.isActive ? 'Active' : 'Disabled'}</Chip>
                </p>
                <p className="mt-1 text-xs text-fg-muted">
                  {String(t.rate)}% · {labelOfTaxType(t.type)} · {t.isInclusive ? 'Tax-inclusive' : 'Tax-exclusive'}
                  {t.countryName === '' ? '' : ` · ${t.countryName} (${t.countryCode})`}
                </p>
                <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-fg-muted">
                  <Chip tone="gray">TIMS {t.timsCode === '' ? '—' : t.timsCode}</Chip>
                  <Chip tone="gray">eTIMS {t.etimsCode === '' ? '—' : t.etimsCode}</Chip>
                  <span>{t.productCount ?? 0} products</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {t.isDefault ? null : (
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void makeDefault(t)} aria-label={`Make ${t.name} the default`}>
                    Make default
                  </button>
                )}
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                  Edit
                </button>
                {t.isDefault ? null : <InlineConfirm label={`Delete ${t.name}`} action="Delete" confirm="Delete (products are reassigned)" busy={busy} onConfirm={() => void remove(t)} />}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more tax rules'}
        </button>
      )}
    </div>
  );
}

/** How the default rule shows prices: with the tax inside, on top, or not set. */
function pricingWords(rule: TaxCategory | null): string {
  if (rule === null) return '—';
  return rule.isInclusive ? 'Inclusive' : 'Exclusive';
}

function Card({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-sunken/80 p-4">
      <p className="text-xs font-medium text-fg-muted">{title}</p>
      <p className="mt-2 text-2xl font-bold text-fg-strong">{value}</p>
      <p className="mt-1 text-[11px] text-fg-subtle">{note}</p>
    </div>
  );
}

/** Previews net, tax and gross for an amount under a rule picked from the server's list. */
function Calculator({ defaultRule }: { defaultRule: TaxCategory | null }) {
  const uid = useId();
  const [amount, setAmount] = useState('');
  const [rule, setRule] = useState<Choice | null>(defaultRule === null ? null : { id: defaultRule.id, label: `${defaultRule.name} (${String(defaultRule.rate)}%) - ${defaultRule.isInclusive ? 'Inclusive' : 'Exclusive'}`, meta: { rate: String(defaultRule.rate), inclusive: defaultRule.isInclusive ? '1' : '' } });
  const sum = breakdown(Number(amount), Number(rule?.meta?.rate ?? 0), rule?.meta?.inclusive === '1');
  const money = (n: number) => `KSh ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return (
    <section className={`${cardClass} space-y-4`} aria-label="Tax calculator">
      <h2 className="text-sm font-bold text-fg-strong">Tax calculator</h2>
      <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-4">
        <div>
          <label htmlFor={`${uid}-amt`} className="mb-1 block text-xs font-semibold text-fg">
            Amount (KSh)
          </label>
          <input id={`${uid}-amt`} type="number" min={0} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className={fieldClass} />
        </div>
        <ChoicePicker label="Tax schedule" source="tax-categories" choice={rule} onChoice={setRule} placeholder="Choose a rule…" />
        <dl className="grid grid-cols-3 gap-2 rounded-lg border border-line bg-surface/60 p-3 md:col-span-2" aria-live="polite">
          <div>
            <dt className="text-[10px] font-bold tracking-wider text-fg-subtle uppercase">Net amount</dt>
            <dd className="text-xs font-semibold text-fg-strong">{money(sum.net)}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold tracking-wider text-emerald-600 uppercase">Tax ({rule?.meta?.rate ?? 0}%)</dt>
            <dd className="text-xs font-semibold text-emerald-600">{money(sum.tax)}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold tracking-wider text-indigo-400 uppercase">Gross total</dt>
            <dd className="text-xs font-bold text-indigo-400">{money(sum.gross)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
