'use client';

import { use, useId, useState } from 'react';
import { ArrowDown, ArrowUp, Megaphone, Plus, Save, Trash2 } from 'lucide-react';
import { type companyBannersAction, saveCompanyBannersAction } from '@/server/domains/company/actions';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { BANNER_LIMITS, type PromoBanner } from '@/config/company-ui';

const fieldClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const labelClass = 'mb-1 block text-xs font-semibold tracking-wider text-fg-subtle uppercase';
const iconBtnClass =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted hover:text-fg-strong disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-500';

const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
};

export function AdminCompanyBannersClient({ bannersPromise }: { bannersPromise: ReturnType<typeof companyBannersAction> }) {
  const loaded = use(bannersPromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <BannersForm initial={loaded.data} />;
}

function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children(id)}
    </div>
  );
}

function BannersForm({ initial }: { initial: PromoBanner[] }) {
  const [banners, setBanners] = useState<PromoBanner[]>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const change = (id: string, changes: Partial<PromoBanner>) => setBanners((list) => list.map((banner) => (banner.id === id ? { ...banner, ...changes } : banner)));

  const save = async () => {
    setMessage(null);
    setError(null);
    setPending(true);
    const result = await attempt(saveCompanyBannersAction(banners));
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBanners(result.data);
    setMessage('Banners saved. The front page shows the ones that are on for today.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong"><Megaphone className="h-5 w-5 text-indigo-400" aria-hidden="true" />Front-page banners</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">A notice across the top of the shop for the days you choose: a sale, a closing date, free delivery. Up to {BANNER_LIMITS.banners}. A button goes to a page of the shop (such as /?category=shoes) or to a web address.</p>
        </div>
        <button type="button" onClick={() => void save()} disabled={pending} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          <Save className="h-4 w-4" aria-hidden="true" />{pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div aria-live="polite">{message === null ? null : <div role="status" className="rounded-lg border border-emerald-800 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}</div>
      {error === null ? null : <div role="alert" className="rounded-lg border border-red-800 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <ul className="space-y-4">
        {banners.map((banner, index) => (
          <li key={banner.id} className="space-y-3 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5">
            <Field label={`Headline of banner ${String(index + 1)}`}>{(id) => <input id={id} className={fieldClass} maxLength={BANNER_LIMITS.title} value={banner.title} onChange={(e) => change(banner.id, { title: e.target.value })} />}</Field>
            <Field label={`Words under the headline of banner ${String(index + 1)}`}>{(id) => <input id={id} className={fieldClass} maxLength={BANNER_LIMITS.text} value={banner.text} onChange={(e) => change(banner.id, { text: e.target.value })} />}</Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={`Button goes to, banner ${String(index + 1)}`}>{(id) => <input id={id} className={fieldClass} maxLength={BANNER_LIMITS.href} value={banner.href} onChange={(e) => change(banner.id, { href: e.target.value })} placeholder="/?category=…" />}</Field>
              <Field label={`Button words, banner ${String(index + 1)}`}>{(id) => <input id={id} className={fieldClass} maxLength={BANNER_LIMITS.cta} value={banner.cta} onChange={(e) => change(banner.id, { cta: e.target.value })} placeholder="Shop now" />}</Field>
              <Field label={`First day shown, banner ${String(index + 1)}`}>{(id) => <input id={id} type="date" className={fieldClass} value={banner.startsOn} onChange={(e) => change(banner.id, { startsOn: e.target.value })} />}</Field>
              <Field label={`Last day shown, banner ${String(index + 1)}`}>{(id) => <input id={id} type="date" className={fieldClass} value={banner.endsOn} onChange={(e) => change(banner.id, { endsOn: e.target.value })} />}</Field>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={banner.active} onChange={(e) => change(banner.id, { active: e.target.checked })} className="h-5 w-5 accent-indigo-600" />Switched on</label>
            <div className="flex gap-2">
              <button type="button" className={iconBtnClass} disabled={index === 0} onClick={() => setBanners((list) => move(list, index, index - 1))} aria-label={`Move banner ${String(index + 1)} up`}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={iconBtnClass} disabled={index === banners.length - 1} onClick={() => setBanners((list) => move(list, index, index + 1))} aria-label={`Move banner ${String(index + 1)} down`}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={`${iconBtnClass} hover:text-red-600`} onClick={() => setBanners((list) => list.filter((item) => item.id !== banner.id))} aria-label={`Remove banner ${String(index + 1)}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" disabled={banners.length >= BANNER_LIMITS.banners} onClick={() => setBanners((list) => [...list, { id: globalThis.crypto.randomUUID(), title: '', text: '', href: '', cta: '', startsOn: '', endsOn: '', active: true }])} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-line bg-surface px-4 py-2 text-sm font-medium text-fg-strong hover:border-indigo-500 disabled:opacity-50">
        <Plus className="h-4 w-4" aria-hidden="true" />Add a banner
      </button>
    </div>
  );
}
