'use client';

import { AppImage } from '@/components/ui/AppImage';
import {
  BRAND_ITEMS,
  BRAND_ITEM_LABELS,
  brandBlock,
  type BrandItem,
  type BrandProfile,
  type BrandShow,
} from '@/lib/print-branding';
import { has } from '@/lib/values';

/** Whether the business has entered the detail an item prints, so a switch that would print nothing can say so. */
function entered(profile: BrandProfile, item: BrandItem): boolean {
  const filled = (v: string | null | undefined): boolean => has((v ?? '').trim());
  switch (item) {
    case 'logo':
      return filled(profile.logoUrl);
    case 'legalName':
      return filled(profile.legalName) && profile.legalName.trim() !== profile.tradingName.trim();
    case 'tagline':
      return filled(profile.tagline);
    case 'address':
      return filled(profile.streetAddress) || filled(profile.city);
    case 'email':
      return filled(profile.email);
    case 'phone':
      return filled(profile.phone) || filled(profile.tel);
    case 'website':
      return filled(profile.website);
    case 'kraPin':
      return filled(profile.kraPin);
  }
}

export interface BrandingPreset {
  label: string;
  show: BrandShow;
}

/**
 * The switches for what a printed heading carries, with a preview built from the business's own details so the choice can be
 * judged before it is saved. `kind` sets how the preview is drawn: the top of a report page, or the top of a till slip.
 */
export function BrandingChoices({
  profile,
  value,
  onChange,
  presets,
  kind,
  name,
}: {
  profile: BrandProfile;
  value: BrandShow;
  onChange: (next: BrandShow) => void;
  presets: readonly BrandingPreset[];
  kind: 'report' | 'receipt';
  /** Distinguishes the switches of two headings on one screen. */
  name: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="space-y-3">
        <fieldset>
          <legend className="text-xs font-semibold text-fg">Show on the heading</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {BRAND_ITEMS.map((item) => (
              <label
                key={item}
                className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-sm text-fg has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/5"
              >
                <input
                  type="checkbox"
                  name={`${name}-${item}`}
                  className="size-4 shrink-0 accent-indigo-600"
                  checked={value[item]}
                  onChange={(event) => onChange({ ...value, [item]: event.target.checked })}
                />
                <span className="min-w-0">
                  {BRAND_ITEM_LABELS[item]}
                  {entered(profile, item) ? null : (
                    <span className="block text-xs text-fg-muted">Not entered in the company profile</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-line-strong px-3 text-xs font-semibold text-fg hover:bg-hover"
              onClick={() => onChange(preset.show)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <HeadingPreview profile={profile} show={value} kind={kind} />
    </div>
  );
}

function HeadingPreview({ profile, show, kind }: { profile: BrandProfile; show: BrandShow; kind: 'report' | 'receipt' }) {
  const block = brandBlock(profile, show);
  const centred = kind === 'receipt';
  return (
    <figure className="m-0 self-start" aria-label="How the heading will look">
      <div
        className={`rounded-lg border border-line bg-white p-4 text-black shadow-sm ${centred ? 'mx-auto max-w-[17rem] text-center font-mono' : ''}`}
      >
        <div className={centred ? 'space-y-1' : 'flex items-start gap-3'}>
          {block.logoUrl === null ? null : (
            <AppImage
              src={block.logoUrl}
              alt=""
              width={44}
              height={44}
              className={centred ? 'mx-auto size-11 object-contain' : 'size-11 shrink-0 object-contain'}
            />
          )}
          <div className="min-w-0 space-y-0.5">
            <p className={`${centred ? 'text-base' : 'text-[0.95rem]'} font-bold leading-tight`}>{block.name}</p>
            {[block.legalName, block.tagline, block.address, ...block.contacts, block.kraPin]
              .filter((line): line is string => line !== null)
              .map((line) => (
                <p key={line} className="text-xs leading-snug text-gray-600">
                  {line}
                </p>
              ))}
          </div>
        </div>
        <div className="mt-3 border-t border-gray-200 pt-3" aria-hidden>
          {centred ? (
            <div className="mx-auto h-2 w-24 rounded bg-gray-200" />
          ) : (
            <>
              <div className="h-3 w-32 rounded bg-gray-300" />
              <div className="mt-2 h-2 w-48 rounded bg-gray-200" />
            </>
          )}
        </div>
      </div>
    </figure>
  );
}
