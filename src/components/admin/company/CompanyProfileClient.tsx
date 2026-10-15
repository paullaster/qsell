'use client';

import { use, useState } from 'react';
import { Building2, FileText, ImagePlus, Landmark, MapPin, Phone, Save } from 'lucide-react';
import { type companyProfileAction, saveCompanyProfileAction } from '@/server/domains/company/actions';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { attempt, LoadFailed, Message, primaryClass, fieldClass, Field, type Notice } from '@/components/ui/screen-kit';
import { profilePayload, type ProfileForm, type ProfileView } from '@/lib/company-forms';
import { LogoUpload } from './LogoUpload';
import { Section, TextField } from './fields';

export function CompanyProfileClient({ profilePromise }: { profilePromise: ReturnType<typeof companyProfileAction> }) {
  const loaded = use(profilePromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <ProfileScreen initial={loaded.data} />;
}

function ProfileScreen({ initial }: { initial: ProfileView }) {
  const [form, setForm] = useState<ProfileForm>(initial);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = <K extends keyof ProfileForm>(key: K) => (value: ProfileForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = profilePayload(form);
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveCompanyProfileAction(form));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setForm(res.data);
    setNotice({ kind: 'ok', text: 'Company profile saved.' });
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label="Company profile" className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <Building2 className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            Company profile
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">Logo, legal identity, address, contact, banking and the invoice footer.</p>
        </div>
        <button type="submit" disabled={busy} className={`${primaryClass} gap-2`}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
      <Message notice={notice} />

      <Section title="Brand & logo" icon={<ImagePlus className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <CompanyBrand tradingName={form.tradingName} tagline={form.tagline} logoUrl={logoUrl} accentColor={initial.accentColor} />
          </div>
          <div className="flex-1 space-y-3">
            <TextField label="Storefront tagline" value={form.tagline} onChange={set('tagline')} placeholder="e.g. Hardware & Electronics" maxLength={120} />
            <LogoUpload onUploaded={setLogoUrl} />
          </div>
        </div>
      </Section>

      <Section title="Identity & tax" icon={<FileText className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField label="Legal name" value={form.legalName} onChange={set('legalName')} required maxLength={120} />
          <TextField label="Trading name" value={form.tradingName} onChange={set('tradingName')} required maxLength={120} />
          <TextField label="KRA PIN" value={form.kraPin} onChange={set('kraPin')} required mono placeholder="P051234567Z" maxLength={11} hint="A letter (A or P), nine digits and a letter." />
          <TextField label="VAT number" value={form.vatNumber} onChange={set('vatNumber')} maxLength={40} />
          <TextField label="Registration number" value={form.registrationNumber} onChange={set('registrationNumber')} maxLength={40} />
          <TextField label="Invoice prefix" value={form.invoicePrefix} onChange={set('invoicePrefix')} required mono placeholder="INV" maxLength={10} />
        </div>
      </Section>

      <Section title="Address & location" icon={<MapPin className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField label="Street address" value={form.streetAddress} onChange={set('streetAddress')} required wide maxLength={160} autoComplete="street-address" />
          <TextField label="City" value={form.city} onChange={set('city')} required maxLength={80} />
          <TextField label="County / state" value={form.countyOrState} onChange={set('countyOrState')} required maxLength={80} />
          <TextField label="Postal code" value={form.postalCode} onChange={set('postalCode')} required maxLength={20} />
          <TextField label="Country" value={form.country} onChange={set('country')} required maxLength={80} />
          <TextField label="Location label" value={form.locationLabel} onChange={set('locationLabel')} wide placeholder="e.g. Westlands Business District" maxLength={120} />
        </div>
      </Section>

      <Section title="Contact" icon={<Phone className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField label="Email" value={form.email} onChange={set('email')} required type="email" inputMode="email" maxLength={160} />
          <TextField label="Phone (mobile)" value={form.phone} onChange={set('phone')} required type="tel" inputMode="tel" maxLength={25} />
          <TextField label="Tel (landline)" value={form.tel} onChange={set('tel')} type="tel" inputMode="tel" maxLength={25} />
          <TextField label="Website" value={form.website} onChange={set('website')} type="url" inputMode="url" placeholder="https://" maxLength={200} />
        </div>
      </Section>

      <Section title="Banking" icon={<Landmark className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField label="Bank name" value={form.bankName} onChange={set('bankName')} maxLength={120} />
          <TextField label="Branch" value={form.bankBranch} onChange={set('bankBranch')} maxLength={120} />
          <TextField label="Account name" value={form.bankAccountName} onChange={set('bankAccountName')} maxLength={120} />
          <TextField label="Account number" value={form.bankAccountNumber} onChange={set('bankAccountNumber')} maxLength={40} />
        </div>
      </Section>

      <Section title="Invoice footer" icon={<FileText className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <Field id="invoice-footer-note" label="Invoice footer note">
          <textarea id="invoice-footer-note" className={`${fieldClass} min-h-24`} maxLength={500} value={form.invoiceFooterNote} onChange={(e) => set('invoiceFooterNote')(e.target.value)} />
        </Field>
      </Section>
    </form>
  );
}
