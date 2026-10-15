'use client';

import { use, useId, useState } from 'react';
import { LayoutGrid, Palette, Save } from 'lucide-react';
import { type companyAppearanceAction, saveCompanyAppearanceAction } from '@/server/domains/company/actions';
import { attempt, LoadFailed, Message, primaryClass, Field, type Notice } from '@/components/ui/screen-kit';
import { PRODUCT_GRID_DESKTOP_COLUMNS, productGridClassName } from '@/config/company-ui';
import { appearancePayload, type AppearanceForm } from '@/lib/company-forms';
import { Section } from './fields';

const PREVIEW_ITEMS = [1, 2, 3, 4];

export function CompanyAppearanceClient({ appearancePromise }: { appearancePromise: ReturnType<typeof companyAppearanceAction> }) {
  const loaded = use(appearancePromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <AppearanceScreen initial={loaded.data} />;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <Field id={id} label={label}>
      <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-11 w-full cursor-pointer rounded-lg border border-line bg-surface" />
      <p className="mt-1 font-mono text-[11px] text-fg-muted">{value}</p>
    </Field>
  );
}

function AppearanceScreen({ initial }: { initial: AppearanceForm }) {
  const [form, setForm] = useState<AppearanceForm>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = appearancePayload(form);
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveCompanyAppearanceAction(form));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setForm(res.data);
    setNotice({ kind: 'ok', text: 'Appearance saved.' });
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label="Appearance" className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <Palette className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            Appearance
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">Brand colours and product listing density for customer-facing screens.</p>
        </div>
        <button type="submit" disabled={busy} className={`${primaryClass} gap-2`}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
      <Message notice={notice} />

      <Section title="Colour scheme" icon={<Palette className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <p className="text-xs text-fg-muted">Primary drives buttons and calls to action across the storefront and admin. Accent is used for the brand mark and invoice highlights.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ColorField label="Primary (buttons & calls to action)" value={form.primaryColor} onChange={(primaryColor) => setForm((f) => ({ ...f, primaryColor }))} />
          <ColorField label="Accent (brand mark / invoices)" value={form.accentColor} onChange={(accentColor) => setForm((f) => ({ ...f, accentColor }))} />
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-4" aria-label="Preview of the colours">
          <span className="text-[11px] font-semibold tracking-wider text-fg-muted uppercase">Preview</span>
          <span className="inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: form.primaryColor }}>
            Primary button
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ backgroundColor: form.accentColor }} aria-hidden="true">
            A
          </span>
        </div>
      </Section>

      <Section title="Product listing density" icon={<LayoutGrid className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <p className="text-xs text-fg-muted">Columns on a desktop screen. Smaller screens scale down from this. The default is 4.</p>
        <div role="group" aria-label="Columns on a desktop screen" className="flex flex-wrap gap-2">
          {PRODUCT_GRID_DESKTOP_COLUMNS.map((columns) => (
            <button
              key={columns}
              type="button"
              aria-pressed={form.desktopColumns === columns}
              onClick={() => setForm((f) => ({ ...f, desktopColumns: columns }))}
              className={`min-h-10 rounded-lg px-4 py-2 text-sm font-semibold ${form.desktopColumns === columns ? 'bg-indigo-600 text-white' : 'bg-surface text-fg-muted ring-1 ring-line hover:text-fg-strong'}`}
            >
              {columns} columns
            </button>
          ))}
        </div>
        <div className="rounded-lg border border-line bg-surface p-4" aria-hidden="true">
          <p className="mb-3 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">Storefront preview (desktop)</p>
          <div className={productGridClassName(form.desktopColumns, 'gap-2')}>
            {PREVIEW_ITEMS.slice(0, form.desktopColumns).map((n) => (
              <div key={n} className="flex h-16 items-center justify-center rounded-md bg-surface-sunken text-xs text-fg-muted">
                Item {n}
              </div>
            ))}
          </div>
        </div>
      </Section>
    </form>
  );
}
