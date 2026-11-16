'use client';

import { use, useId, useState } from 'react';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, type Notice } from '@/components/ui/screen-kit';
import { preparationSheetAction } from '@/server/domains/pricing/preparation-actions';
import type { PreparationView } from '@/server/domains/pricing/preparation-service';

type Loaded = Awaited<ReturnType<typeof preparationSheetAction>>;

const dayWords = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function PreparationClient({ initialPromise }: { initialPromise: ReturnType<typeof preparationSheetAction> }) {
  const res: Loaded = use(initialPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  if (res.data.view === null) return <LoadFailed error={res.data.error ?? 'Something went wrong.'} />;
  return <Body today={res.data.today} initial={res.data.view} />;
}

function Body({ today, initial }: { today: string; initial: PreparationView }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const open = async (day: string) => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(preparationSheetAction(day));
    setBusy(false);
    if (!r.ok) setNotice({ kind: 'error', text: r.error });
    else if (r.data.view === null) setNotice({ kind: 'error', text: r.data.error ?? 'Something went wrong.' });
    else setView(r.data.view);
  };

  const { sheet } = view;
  const title = view.day === null ? 'Orders with no date' : dayWords(view.day);
  return (
    <div className="space-y-5">
      <div className="print:hidden">
        <PageHeader
          title="Preparation sheet"
          intro="What has to be made for a day, from the choices on each order. Totals add every serving up; each order's own choices are listed under it. A cancelled order is not on the sheet."
          actions={<button type="button" className={buttonClass} onClick={() => window.print()}>Print</button>}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field id={`${uid}-day`} label="Day">
          <input id={`${uid}-day`} type="date" className={fieldClass} value={view.day ?? ''} onChange={(e) => e.target.value !== '' && void open(e.target.value)} disabled={busy} />
        </Field>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void open(today)}>Today</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void open('none')}>Orders with no date</button>
      </div>
      {view.days.length === 0 ? null : (
        <nav aria-label="Days with orders" className="flex flex-wrap gap-2 print:hidden">
          {view.days.map((d) => (
            <button key={d.date} type="button" disabled={busy} onClick={() => void open(d.date)} aria-current={d.date === view.day ? 'date' : undefined} className={`min-h-10 cursor-pointer rounded-lg border px-3 text-sm ${d.date === view.day ? 'border-indigo-500 bg-indigo-500/10 font-semibold' : 'border-line hover:bg-hover'}`}>
              {new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} · {d.servings}
            </button>
          ))}
        </nav>
      )}
      <Message notice={notice} />

      <section aria-labelledby={`${uid}-title`} className="space-y-4" data-testid="preparation-sheet">
        <h2 id={`${uid}-title`} className="text-lg font-bold text-fg-strong">{title}</h2>
        {view.truncated ? <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">There are more orders than one sheet holds. The first ones are shown; the totals are for those only.</p> : null}
        {sheet.groups.length === 0 ? <p className="text-sm text-fg-muted" role="status">Nothing to prepare for this day.</p> : null}

        {sheet.groups.length === 0 ? null : (
          <div className={`${cardClass} space-y-4`} data-testid="preparation-totals">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h3 className="text-sm font-bold text-fg-strong">Totals</h3>
              <p className="text-sm text-fg-muted">{sheet.totals.servings} servings in {sheet.orders} {sheet.orders === 1 ? 'order' : 'orders'}</p>
            </div>
            <ul className="flex flex-wrap gap-2" aria-label="Servings of each package">
              {sheet.totals.packages.map((p) => <li key={p.packageProductId}><Chip tone="sky">{p.packageName}: {p.servings}</Chip></li>)}
            </ul>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3" aria-label="What to prepare">
              {sheet.totals.parts.map((part) => (
                <li key={part.productId} className="flex items-baseline justify-between gap-3 border-b border-line py-1 text-sm">
                  <span className="min-w-0 break-words text-fg-strong">{part.productName}</span>
                  <span className="shrink-0 font-mono font-semibold">{part.portions}{part.units === part.portions ? '' : ` (${String(part.units)} units)`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {sheet.groups.map((group) => (
          <div key={`${group.startsAt ?? 'none'}-${group.slotName ?? ''}`} className="space-y-3">
            <h3 className="text-base font-bold text-fg-strong">{group.slotName === null ? 'No delivery time chosen' : `${group.slotName} (from ${group.startsAt ?? ''})`} <span className="text-sm font-normal text-fg-muted">· {group.servings} servings</span></h3>
            {group.packages.map((pkg) => (
              <div key={pkg.packageProductId} className={`${cardClass} space-y-2`}>
                <h4 className="text-sm font-semibold text-fg-strong">{pkg.packageName} <span className="font-normal text-fg-muted">· {pkg.servings} servings</span></h4>
                <ul className="divide-y divide-line">
                  {pkg.selections.map((s) => (
                    <li key={s.instanceId} className="space-y-0.5 py-2 text-sm" data-testid="preparation-selection">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-semibold text-fg-strong">{s.servings} × {s.words}</span>
                        <span className="text-xs text-fg-muted">{s.orderNumber} · {s.customerName}{s.paymentStatus === 'paid' ? '' : ` · ${s.paymentStatus}`}</span>
                      </div>
                      {s.note === '' ? null : <p className="text-sm font-medium text-amber-700 dark:text-amber-300" data-testid="preparation-note">Note: {s.note}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
