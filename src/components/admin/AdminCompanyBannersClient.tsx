'use client';

import { use, useId, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Megaphone, Plus, Save, Trash2 } from 'lucide-react';
import { type companyBannersAction, saveCompanyBannersAction } from '@/server/domains/company/actions';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { BANNER_LIMITS, contrastRatio, isReadable, MIN_BANNER_CONTRAST, readableTextOn, textColorFor, type PromoBanner } from '@/config/company-ui';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { BannerView } from '@/components/store/BannerView';
import { checkImageFile, uploadImage } from '@/lib/mediaUpload';
import { BANNER_MOTION_CHOICES, BANNER_SIZE_CHOICES, BANNER_SPEED_CHOICES, labelOfChoice } from '@/lib/banner-choices';

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

const PRESETS = [
  { name: 'Bright red', background: '#dc2626' },
  { name: 'Sunny yellow', background: '#facc15' },
  { name: 'Deep blue', background: '#1d4ed8' },
  { name: 'Black', background: '#111827' },
  { name: 'Fresh green', background: '#15803d' },
] as const;

const swatchClass = 'h-11 w-16 cursor-pointer rounded-lg border border-line bg-surface p-1';
const smallBtn = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-surface px-3 text-xs font-semibold text-fg hover:border-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500';

/** Colours for one banner: the shop's look by default, or a background and text colour of the company's choosing, with a check that the words can be read. */
function ColourFields({ banner, number, onChange }: { banner: PromoBanner; number: number; onChange: (changes: Partial<PromoBanner>) => void }) {
  const custom = banner.background !== '';
  const text = textColorFor(banner.background, banner.textColor);
  const chosen = banner.textColor === '' ? text : banner.textColor;
  const ratio = custom ? contrastRatio(chosen, banner.background) : 0;
  const readable = custom && isReadable(chosen, banner.background);
  return (
    <fieldset className="space-y-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-xs font-semibold tracking-wider text-fg-subtle uppercase">Colours, banner {number}</legend>
      <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={custom}
          onChange={(e) => onChange(e.target.checked ? { background: '#dc2626', textColor: '' } : { background: '', textColor: '' })}
          className="h-5 w-5 accent-indigo-600"
        />
        Use my own colours (otherwise the shop&apos;s usual look)
      </label>
      {custom ? (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`Ready-made colours, banner ${String(number)}`}>
            {PRESETS.map((preset) => (
              <button key={preset.name} type="button" className={smallBtn} onClick={() => onChange({ background: preset.background, textColor: '' })}>
                <span aria-hidden="true" className="mr-2 inline-block h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.background }} />
                {preset.name}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={`Background colour, banner ${String(number)}`}>
              {(id) => <input id={id} type="color" className={swatchClass} value={banner.background} onChange={(e) => onChange({ background: e.target.value })} />}
            </Field>
            <Field label={`Text colour, banner ${String(number)}`}>
              {(id) => <input id={id} type="color" className={swatchClass} value={chosen} onChange={(e) => onChange({ textColor: e.target.value })} />}
            </Field>
            <button type="button" className={smallBtn} onClick={() => onChange({ textColor: '' })}>Pick the text colour for me</button>
            <button type="button" className={smallBtn} onClick={() => onChange({ textColor: readableTextOn(banner.background) })}>
              Use {readableTextOn(banner.background) === '#ffffff' ? 'white' : 'dark'} text
            </button>
          </div>
          <p role="status" className={`text-xs ${readable ? 'text-emerald-700' : 'text-red-700'}`}>
            {readable
              ? `The words can be read on this background (contrast ${ratio.toFixed(1)} to 1).`
              : `These words are too hard to read on this background (contrast ${ratio.toFixed(1)} to 1, at least ${String(MIN_BANNER_CONTRAST)} is needed). The shop will use ${text === '#ffffff' ? 'white' : 'dark'} text instead.`}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

/** A picture for one banner, uploaded to the media library. */
function PictureField({ banner, number, onChange }: { banner: PromoBanner; number: number; onChange: (changes: Partial<PromoBanner>) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = async (file: File | null) => {
    if (file === null) return;
    const bad = checkImageFile(file);
    if (bad !== null) {
      setProblem(bad);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const { asset } = await uploadImage(file, { purpose: 'banner' });
      onChange({ imageUrl: asset.url });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The picture could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Field label={`Picture, banner ${String(number)} (optional)`}>
        {(id) => (
          <input
            id={id}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            className="block min-h-11 w-full text-sm text-fg-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-500"
          />
        )}
      </Field>
      <div aria-live="polite">
        {busy ? <p role="status" className="text-xs text-indigo-600">Uploading the picture…</p> : null}
        {problem === null ? null : <p role="alert" className="text-xs text-red-700">{problem}</p>}
      </div>
      {banner.imageUrl === '' ? null : (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a preview of the uploaded file */}
          <img src={banner.imageUrl} alt={`The picture chosen for banner ${String(number)}`} className="h-12 w-auto max-w-[40%] rounded-md border border-line object-contain" />
          <button type="button" className={smallBtn} onClick={() => onChange({ imageUrl: '' })}><ImagePlus className="mr-1 h-4 w-4" aria-hidden="true" />Remove the picture</button>
        </div>
      )}
    </div>
  );
}

/** How a banner draws the eye: still, scrolling or pulsing; how fast; how big. */
function AttentionFields({ banner, number, onChange }: { banner: PromoBanner; number: number; onChange: (changes: Partial<PromoBanner>) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <ChoicePicker label={`Movement, banner ${String(number)}`} source="banner-motions" clearable={false} choice={{ id: banner.motion, label: labelOfChoice(BANNER_MOTION_CHOICES, banner.motion) }} onChoice={(c) => c !== null && onChange({ motion: c.id as PromoBanner['motion'] })} />
      {banner.motion === 'marquee' ? (
        <ChoicePicker label={`Scrolling speed, banner ${String(number)}`} source="banner-speeds" clearable={false} choice={{ id: banner.speed, label: labelOfChoice(BANNER_SPEED_CHOICES, banner.speed) }} onChoice={(c) => c !== null && onChange({ speed: c.id as PromoBanner['speed'] })} />
      ) : null}
      <ChoicePicker label={`Size, banner ${String(number)}`} source="banner-sizes" clearable={false} choice={{ id: banner.size, label: labelOfChoice(BANNER_SIZE_CHOICES, banner.size) }} onChoice={(c) => c !== null && onChange({ size: c.id as PromoBanner['size'] })} />
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
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">A notice across the top of the shop for the days you choose: a sale, a closing date, free delivery. Up to {BANNER_LIMITS.banners}. It starts in the shop&apos;s usual look; choose your own colours, add a picture, or make it scroll or glow so it is noticed. Text is always kept readable on the colour you pick. A button goes to a page of the shop (such as /?category=shoes) or to a web address.</p>
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
            <ColourFields banner={banner} number={index + 1} onChange={(changes) => change(banner.id, changes)} />
            <PictureField banner={banner} number={index + 1} onChange={(changes) => change(banner.id, changes)} />
            <AttentionFields banner={banner} number={index + 1} onChange={(changes) => change(banner.id, changes)} />
            <div>
              <p className={labelClass}>How it looks in the shop, banner {String(index + 1)}</p>
              <BannerView banner={{ ...banner, title: banner.title === '' ? 'Your headline appears here' : banner.title, cta: banner.cta === '' ? 'Shop now' : banner.cta }} />
            </div>
            <div className="flex gap-2">
              <button type="button" className={iconBtnClass} disabled={index === 0} onClick={() => setBanners((list) => move(list, index, index - 1))} aria-label={`Move banner ${String(index + 1)} up`}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={iconBtnClass} disabled={index === banners.length - 1} onClick={() => setBanners((list) => move(list, index, index + 1))} aria-label={`Move banner ${String(index + 1)} down`}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={`${iconBtnClass} hover:text-red-600`} onClick={() => setBanners((list) => list.filter((item) => item.id !== banner.id))} aria-label={`Remove banner ${String(index + 1)}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" disabled={banners.length >= BANNER_LIMITS.banners} onClick={() => setBanners((list) => [...list, { id: globalThis.crypto.randomUUID(), title: '', text: '', href: '', cta: '', startsOn: '', endsOn: '', active: true, background: '', textColor: '', imageUrl: '', motion: 'still', speed: 'normal', size: 'normal' }])} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-line bg-surface px-4 py-2 text-sm font-medium text-fg-strong hover:border-indigo-500 disabled:opacity-50">
        <Plus className="h-4 w-4" aria-hidden="true" />Add a banner
      </button>
    </div>
  );
}
