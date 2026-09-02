'use client';

import { use, useState, useTransition, useRef } from 'react';
import { Building2, Save, MapPin, Phone, Landmark, Palette, FileText, ImagePlus } from 'lucide-react';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import {
  updateCompanySettingsAction,
  uploadCompanyLogoAction,
} from '@/server/domains/company/actions';
import { CompanyBrand } from '@/components/ui/CompanyBrand';

interface Props {
  settingsPromise: Promise<CompanySettingsRow>;
}

export function AdminCompanyClient({ settingsPromise }: Props) {
  const initial = use(settingsPromise);
  const [form, setForm] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [logoPending, setLogoPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setField = <K extends keyof CompanySettingsRow>(key: K, value: CompanySettingsRow[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onSave = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const updated = await updateCompanySettingsAction({
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
          primaryColor: form.primaryColor,
          accentColor: form.accentColor,
        });
        setForm(updated);
        setMessage('Company profile saved. Storefront, invoices, and emails will use the updated details.');
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
    'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';
  const labelClass = 'mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-white">
            <Building2 className="h-5 w-5 text-indigo-400" />
            Company Setup
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Configure brand identity, logo, legal details, KRA PIN, and banking used on the
            storefront, tax invoices, and customer emails.
          </p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {pending ? 'Saving…' : 'Save company profile'}
        </button>
      </div>

      {message ? (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <ImagePlus className="h-4 w-4 text-indigo-400" /> Brand & logo
        </h3>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3">
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
                className="block w-full text-sm text-zinc-400 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-500"
                disabled={logoPending}
                onChange={(e) => onLogoSelected(e.target.files?.[0] ?? null)}
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                PNG, JPEG, WebP, or SVG up to 2MB. Used in navbar, admin, invoices, and emails.
              </p>
              {logoPending ? (
                <p className="mt-1 text-xs text-indigo-300">Uploading logo…</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
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

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
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

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
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

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
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

      <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <Palette className="h-4 w-4 text-indigo-400" /> Invoice branding
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass}>Primary color</label>
            <input
              type="color"
              className="h-10 w-full cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950"
              value={form.primaryColor}
              onChange={(e) => setField('primaryColor', e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Accent color</label>
            <input
              type="color"
              className="h-10 w-full cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950"
              value={form.accentColor}
              onChange={(e) => setField('accentColor', e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Invoice footer note</label>
            <textarea
              className={`${fieldClass} min-h-24`}
              value={form.invoiceFooterNote || ''}
              onChange={(e) => setField('invoiceFooterNote', e.target.value || null)}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
