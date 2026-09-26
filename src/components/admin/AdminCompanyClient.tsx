'use client';

import { use, useMemo, useState, useTransition, useRef } from 'react';
import {
  Building2,
  Save,
  MapPin,
  Phone,
  Landmark,
  Palette,
  FileText,
  ImagePlus,
  LayoutGrid,
  Tags,
} from 'lucide-react';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import {
  updateCompanySettingsAction,
  uploadCompanyLogoAction,
} from '@/server/domains/company/actions';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { getAdminNav } from '@/config/admin-nav';
import {
  PRODUCT_GRID_DESKTOP_COLUMNS,
  flattenModuleLabelOptions,
  productGridClassName,
  resolveCompanyUiConfig,
  toCompanyUiConfigRaw,
  type CompanyUiConfig,
  type ProductGridDesktopColumns,
} from '@/config/company-ui';

export type CompanySetupSection = 'profile' | 'appearance' | 'modules';

const SECTION_META: Record<
  CompanySetupSection,
  { title: string; description: string; icon: typeof Building2 }
> = {
  profile: {
    title: 'Company profile',
    description: 'Logo, legal identity, address, contact, banking, and invoice footer.',
    icon: Building2,
  },
  appearance: {
    title: 'Appearance',
    description: 'Brand colors and product listing density for customer-facing screens.',
    icon: Palette,
  },
  modules: {
    title: 'Module names',
    description: 'Override sidebar and page titles. Routes stay the same — only labels change.',
    icon: Tags,
  },
};

interface Props {
  settingsPromise: Promise<CompanySettingsRow>;
  section: CompanySetupSection;
}

export function AdminCompanyClient({ settingsPromise, section }: Props) {
  const initial = use(settingsPromise);
  const [form, setForm] = useState(initial);
  const [uiConfig, setUiConfig] = useState<CompanyUiConfig>(() =>
    resolveCompanyUiConfig(initial.uiConfig),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [logoPending, setLogoPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const moduleOptions = useMemo(() => flattenModuleLabelOptions(getAdminNav()), []);
  const meta = SECTION_META[section];
  const SectionIcon = meta.icon;

  const setField = <K extends keyof CompanySettingsRow>(key: K, value: CompanySettingsRow[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setDesktopColumns = (desktopColumns: ProductGridDesktopColumns) => {
    setUiConfig((prev) => ({
      ...prev,
      productGrid: { ...prev.productGrid, desktopColumns },
    }));
  };

  const setModuleLabel = (id: string, value: string) => {
    setUiConfig((prev) => {
      const next = { ...prev.moduleLabels };
      const trimmed = value.trim();
      if (!trimmed) delete next[id];
      else next[id] = trimmed.slice(0, 80);
      return { ...prev, moduleLabels: next };
    });
  };

  const onSave = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const updated =
          section === 'profile'
            ? await updateCompanySettingsAction({
                legalName: form.legalName,
                tradingName: form.tradingName,
                email: form.email,
                phone: form.phone,
                tel: form.tel,
                website: form.website,
                streetAddress: form.streetAddress,
                city: form.city,
                countyOrState: form.countyOrState,
                postalCode: form.postalCode,
                country: form.country,
                locationLabel: form.locationLabel,
                tagline: form.tagline,
                kraPin: form.kraPin,
                vatNumber: form.vatNumber,
                registrationNumber: form.registrationNumber,
                bankName: form.bankName,
                bankAccountName: form.bankAccountName,
                bankAccountNumber: form.bankAccountNumber,
                bankBranch: form.bankBranch,
                invoiceFooterNote: form.invoiceFooterNote,
                invoicePrefix: form.invoicePrefix,
                logoUrl: form.logoUrl,
              })
            : section === 'appearance'
              ? await updateCompanySettingsAction({
                  primaryColor: form.primaryColor,
                  accentColor: form.accentColor,
                  uiConfig: toCompanyUiConfigRaw(uiConfig),
                })
              : await updateCompanySettingsAction({
                  uiConfig: toCompanyUiConfigRaw(uiConfig),
                });

        setForm(updated);
        setUiConfig(resolveCompanyUiConfig(updated.uiConfig));
        setMessage(`${meta.title} saved.`);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save company settings');
      }
    });
  };

  const onLogoSelected = (file: File | null) => {
    if (!file) return;
    setMessage(null);
    setError(null);
    setLogoPending(true);
    const data = new FormData();
    data.set('logo', file);
    void uploadCompanyLogoAction(data)
      .then((updated) => {
        setForm(updated);
        setMessage('Logo uploaded. Navbar, admin, invoices, and emails will use it.');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Logo upload failed');
      })
      .finally(() => {
        setLogoPending(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      });
  };

  const fieldClass =
    'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';
  const labelClass = 'mb-1 block text-[11px] font-semibold uppercase tracking-wider text-fg-subtle';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <SectionIcon className="h-5 w-5 text-indigo-400" />
            {meta.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">{meta.description}</p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>

      {message ? (
        <div className="rounded-lg border border-emerald-800 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {section === 'profile' ? (
        <>
          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <ImagePlus className="h-4 w-4 text-indigo-400" /> Brand & logo
            </h3>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="rounded-xl border border-line bg-surface px-4 py-3">
                <CompanyBrand
                  tradingName={form.tradingName}
                  tagline={form.tagline}
                  logoUrl={form.logoUrl}
                  accentColor={form.accentColor}
                />
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <label className={labelClass}>Storefront tagline</label>
                  <input
                    className={fieldClass}
                    placeholder="e.g. Hardware & Electronics"
                    value={form.tagline || ''}
                    onChange={(e) => setField('tagline', e.target.value || null)}
                  />
                </div>
                <div>
                  <label className={labelClass}>Company logo</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="file:TW block w-full text-sm text-fg-muted file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-semibold hover:file:bg-indigo-500"
                    disabled={logoPending}
                    onChange={(e) => onLogoSelected(e.target.files?.[0] ?? null)}
                  />
                  <p className="mt-1 text-[11px] text-fg-subtle">
                    PNG, JPEG, WebP, or SVG up to 2MB. Used in navbar, admin, invoices, and emails.
                  </p>
                  {logoPending ? (
                    <p className="mt-1 text-xs text-indigo-300">Uploading logo…</p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <FileText className="h-4 w-4 text-indigo-400" /> Identity & tax
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelClass}>Legal name</label>
                <input
                  className={fieldClass}
                  value={form.legalName}
                  onChange={(e) => setField('legalName', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Trading name</label>
                <input
                  className={fieldClass}
                  value={form.tradingName}
                  onChange={(e) => setField('tradingName', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>KRA PIN</label>
                <input
                  className={fieldClass}
                  value={form.kraPin}
                  onChange={(e) => setField('kraPin', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>VAT number</label>
                <input
                  className={fieldClass}
                  value={form.vatNumber || ''}
                  onChange={(e) => setField('vatNumber', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Registration number</label>
                <input
                  className={fieldClass}
                  value={form.registrationNumber || ''}
                  onChange={(e) => setField('registrationNumber', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Invoice prefix</label>
                <input
                  className={fieldClass}
                  value={form.invoicePrefix}
                  onChange={(e) => setField('invoicePrefix', e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <MapPin className="h-4 w-4 text-indigo-400" /> Address & location
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className={labelClass}>Street address</label>
                <input
                  className={fieldClass}
                  value={form.streetAddress}
                  onChange={(e) => setField('streetAddress', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>City</label>
                <input
                  className={fieldClass}
                  value={form.city}
                  onChange={(e) => setField('city', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>County / State</label>
                <input
                  className={fieldClass}
                  value={form.countyOrState}
                  onChange={(e) => setField('countyOrState', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Postal code</label>
                <input
                  className={fieldClass}
                  value={form.postalCode}
                  onChange={(e) => setField('postalCode', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Country</label>
                <input
                  className={fieldClass}
                  value={form.country}
                  onChange={(e) => setField('country', e.target.value)}
                />
              </div>
              <div className="md:col-span-2">
                <label className={labelClass}>Location label</label>
                <input
                  className={fieldClass}
                  value={form.locationLabel || ''}
                  onChange={(e) => setField('locationLabel', e.target.value || null)}
                  placeholder="e.g. Westlands Business District"
                />
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <Phone className="h-4 w-4 text-indigo-400" /> Contact
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelClass}>Email</label>
                <input
                  className={fieldClass}
                  value={form.email}
                  onChange={(e) => setField('email', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Phone (mobile)</label>
                <input
                  className={fieldClass}
                  value={form.phone}
                  onChange={(e) => setField('phone', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Tel (landline)</label>
                <input
                  className={fieldClass}
                  value={form.tel || ''}
                  onChange={(e) => setField('tel', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Website</label>
                <input
                  className={fieldClass}
                  value={form.website || ''}
                  onChange={(e) => setField('website', e.target.value || null)}
                />
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <Landmark className="h-4 w-4 text-indigo-400" /> Banking
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelClass}>Bank name</label>
                <input
                  className={fieldClass}
                  value={form.bankName || ''}
                  onChange={(e) => setField('bankName', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Branch</label>
                <input
                  className={fieldClass}
                  value={form.bankBranch || ''}
                  onChange={(e) => setField('bankBranch', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Account name</label>
                <input
                  className={fieldClass}
                  value={form.bankAccountName || ''}
                  onChange={(e) => setField('bankAccountName', e.target.value || null)}
                />
              </div>
              <div>
                <label className={labelClass}>Account number</label>
                <input
                  className={fieldClass}
                  value={form.bankAccountNumber || ''}
                  onChange={(e) => setField('bankAccountNumber', e.target.value || null)}
                />
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <FileText className="h-4 w-4 text-indigo-400" /> Invoice footer
            </h3>
            <div>
              <label className={labelClass}>Invoice footer note</label>
              <textarea
                className={`${fieldClass} min-h-24`}
                value={form.invoiceFooterNote || ''}
                onChange={(e) => setField('invoiceFooterNote', e.target.value || null)}
              />
            </div>
          </section>
        </>
      ) : null}

      {section === 'appearance' ? (
        <>
          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <Palette className="h-4 w-4 text-indigo-400" /> Color scheme
            </h3>
            <p className="text-xs text-fg-muted">
              Primary drives buttons and CTAs across storefront and admin at runtime. Accent is used
              for the brand mark and invoice highlights.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelClass}>Primary (buttons & CTAs)</label>
                <input
                  type="color"
                  className="h-10 w-full cursor-pointer rounded-lg border border-line bg-surface"
                  value={form.primaryColor}
                  onChange={(e) => setField('primaryColor', e.target.value)}
                />
                <p className="mt-1 font-mono text-[11px] text-fg-subtle">{form.primaryColor}</p>
              </div>
              <div>
                <label className={labelClass}>Accent (brand mark / invoices)</label>
                <input
                  type="color"
                  className="h-10 w-full cursor-pointer rounded-lg border border-line bg-surface"
                  value={form.accentColor}
                  onChange={(e) => setField('accentColor', e.target.value)}
                />
                <p className="mt-1 font-mono text-[11px] text-fg-subtle">{form.accentColor}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-4">
              <span className="text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
                Preview
              </span>
              <button
                type="button"
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                style={{ backgroundColor: form.primaryColor }}
              >
                Primary button
              </button>
              <div
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-fg-strong"
                style={{ backgroundColor: form.accentColor }}
              >
                A
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
              <LayoutGrid className="h-4 w-4 text-indigo-400" /> Product listing density
            </h3>
            <p className="text-xs text-fg-muted">
              Columns at ~1140px desktop width. Smaller screens scale down from this value. Default
              is 4.
            </p>
            <div className="flex flex-wrap gap-2">
              {PRODUCT_GRID_DESKTOP_COLUMNS.map((cols) => (
                <button
                  key={cols}
                  type="button"
                  onClick={() => setDesktopColumns(cols)}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                    uiConfig.productGrid.desktopColumns === cols
                      ? 'TW bg-indigo-600'
                      : 'hover:TW bg-surface text-fg-muted ring-1 ring-line'
                  }`}
                >
                  {cols} columns
                </button>
              ))}
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="mb-3 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
                Storefront preview (~desktop)
              </p>
              <div className={productGridClassName(uiConfig.productGrid.desktopColumns, 'gap-2')}>
                {Array.from({ length: uiConfig.productGrid.desktopColumns }).map((_, i) => (
                  <div
                    key={i}
                    className="flex h-16 items-center justify-center rounded-md bg-surface-sunken text-xs text-fg-muted"
                  >
                    Item {i + 1}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      ) : null}

      {section === 'modules' ? (
        <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
            <Tags className="h-4 w-4 text-indigo-400" /> Module display names
          </h3>
          <p className="text-xs text-fg-muted">
            Leave blank to keep the built-in name. Unknown or empty overrides are ignored.
          </p>
          <div className="space-y-3">
            {moduleOptions.map((mod) => (
              <div
                key={mod.id}
                className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
                style={{ paddingLeft: `${mod.depth * 12}px` }}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg-strong">{mod.defaultTitle}</p>
                  <p className="truncate font-mono text-[10px] text-fg-subtle">
                    {mod.id} · {mod.href}
                  </p>
                </div>
                <input
                  className={fieldClass}
                  placeholder={mod.defaultTitle}
                  value={uiConfig.moduleLabels[mod.id] ?? ''}
                  onChange={(e) => setModuleLabel(mod.id, e.target.value)}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
