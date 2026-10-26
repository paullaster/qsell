'use client';

import Link from 'next/link';
import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addBankAction, addDirectorAction, type profileFormAction, removeBankAction, removeDirectorAction, removeDocumentAction, saveBusinessAction, saveContactsAction, saveFinancialAction, saveProfileAction, saveReferencesAction,
} from '@/server/domains/vendors/profile-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { VENDOR_TYPES } from '@/lib/vendor-forms';
import { CONTACT_ROLES, DESTINATION_KINDS, numberLabel, ID_TYPES, TURNOVER_BANDS, maskAccount, type BusinessData, type ContactInput, type FinancialData, type ProfileData, type ReferenceInput } from '@/lib/vendor-profile';
import type { Choice } from '@/lib/payment-options';

type Form = Extract<Awaited<ReturnType<typeof profileFormAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string; problems?: Record<string, string> };

export function SectionClient({ formPromise }: { formPromise: ReturnType<typeof profileFormAction> }) {
  const res = use(formPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <SectionView form={res.data} />;
}

const optionOf = (list: readonly { id: string; label: string }[], id: string): Choice | null => {
  const found = list.find((x) => x.id === id);
  return found === undefined ? null : { id: found.id, label: found.label };
};

/** One place that runs a save, keeps its message and the field problems, and refreshes the page behind it. */
function useSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const save = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setProblems({});
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblems('problems' in res && res.problems !== undefined ? res.problems : {});
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  return { busy, notice, problems, save };
}

const err = (problems: Record<string, string>, key: string): string | undefined => problems[key];

function Text({ id, label, value, onChange, problem, type = 'text', hint, disabled, required, autoComplete = 'off' }: { id: string; label: string; value: string; onChange: (v: string) => void; problem?: string; type?: string; hint?: string; disabled: boolean; required?: boolean; autoComplete?: string }) {
  return (
    <Field id={id} label={label} hint={problem ?? hint}>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} disabled={disabled} required={required} aria-invalid={problem !== undefined} aria-describedby={problem === undefined ? undefined : `${id}-hint`} autoComplete={autoComplete} />
    </Field>
  );
}

function SectionView({ form }: { form: Form }) {
  const section = form.section;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={form.label} actions={<Link href="/vendor/profile" className={buttonClass}>Back to my profile</Link>} />
      {form.note === null ? null : <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg"><span className="font-semibold">We asked you to fix:</span> {form.note}</p>}
      {form.readOnlyBecause === null ? null : <p role="status" className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-fg-muted">{form.readOnlyBecause}</p>}
      {section === 'profile' ? <ProfileSection form={form} /> : null}
      {section === 'business' ? <BusinessSection form={form} /> : null}
      {section === 'financial' ? <FinancialSection form={form} /> : null}
      {section === 'contacts' ? <ContactsSection form={form} /> : null}
      {section === 'attachments' ? <AttachmentsSection form={form} /> : null}
    </div>
  );
}

function ProfileSection({ form }: { form: Form }) {
  const uid = useId();
  const { busy, notice, problems, save } = useSave();
  const [d, setD] = useState<ProfileData>(form.profile);
  const set = <K extends keyof ProfileData>(k: K, v: ProfileData[K]) => setD((p) => ({ ...p, [k]: v }));
  const off = !form.canEdit;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(saveProfileAction(d), 'Saved.'); }} noValidate className={`${cardClass} space-y-4`} aria-label="Vendor profile">
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Kind of business" source="vendor-types" choice={optionOf(VENDOR_TYPES, d.vendorType)} onChoice={(c) => set('vendorType', c?.id ?? 'company')} clearable={false} disabled={off} />
        <Text id={`${uid}-tn`} label="Trading name" value={d.tradingName} onChange={(v) => set('tradingName', v)} problem={err(problems, 'tradingName')} disabled={off} />
      </div>
      <Field id={`${uid}-desc`} label="What you supply" hint={err(problems, 'description') ?? 'A sentence or two about your products or services.'}>
        <textarea id={`${uid}-desc`} value={d.description} onChange={(e) => set('description', e.target.value)} rows={3} className={fieldClass} disabled={off} aria-invalid={err(problems, 'description') !== undefined} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Text id={`${uid}-c`} label="Country" value={d.country} onChange={(v) => set('country', v)} problem={err(problems, 'country')} disabled={off} required autoComplete="country-name" />
        <Text id={`${uid}-y`} label="Year established" value={d.yearEstablished} onChange={(v) => set('yearEstablished', v)} problem={err(problems, 'yearEstablished')} disabled={off} />
        <Text id={`${uid}-st`} label="Street or building" value={d.physicalStreet} onChange={(v) => set('physicalStreet', v)} problem={err(problems, 'physicalStreet')} disabled={off} required autoComplete="street-address" />
        <Text id={`${uid}-ci`} label="Town or city" value={d.physicalCity} onChange={(v) => set('physicalCity', v)} problem={err(problems, 'physicalCity')} disabled={off} required autoComplete="address-level2" />
        <Text id={`${uid}-co`} label="County or state" value={d.physicalCounty} onChange={(v) => set('physicalCounty', v)} disabled={off} autoComplete="address-level1" />
        <Text id={`${uid}-pc`} label="Postal code" value={d.physicalPostalCode} onChange={(v) => set('physicalPostalCode', v)} disabled={off} autoComplete="postal-code" />
        <Text id={`${uid}-po`} label="Postal address" value={d.postalAddress} onChange={(v) => set('postalAddress', v)} disabled={off} hint="For example P.O. Box 123-00100." />
        <Text id={`${uid}-ph`} label="Business phone" type="tel" value={d.phone} onChange={(v) => set('phone', v)} problem={err(problems, 'phone')} disabled={off} required autoComplete="tel" />
        <Text id={`${uid}-w`} label="Website" type="url" value={d.website} onChange={(v) => set('website', v)} problem={err(problems, 'website')} disabled={off} hint="Starts with https://" />
      </div>
      {off ? null : <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
    </form>
  );
}

function BusinessSection({ form }: { form: Form }) {
  const uid = useId();
  const { busy, notice, problems, save } = useSave();
  const director = useSave();
  const refs = useSave();
  const [d, setD] = useState<BusinessData>(form.business);
  const [dir, setDir] = useState({ name: '', idType: 'national_id', idNumber: '', sharePercent: '' });
  const [list, setList] = useState<(ReferenceInput & { k: string })[]>(() => form.references.map((r) => ({ ...r, k: crypto.randomUUID() })));
  const set = <K extends keyof BusinessData>(k: K, v: BusinessData[K]) => setD((p) => ({ ...p, [k]: v }));
  const off = !form.canEdit;
  const setRef = (i: number, patch: Partial<ReferenceInput>) => setList((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-5">
      <form onSubmit={(e) => { e.preventDefault(); void save(saveBusinessAction(d), 'Saved.'); }} noValidate className={`${cardClass} space-y-4`} aria-label="Business details">
        <Message notice={notice} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Text id={`${uid}-rn`} label="Registration number" value={d.registrationNo} onChange={(v) => set('registrationNo', v)} problem={err(problems, 'registrationNo')} disabled={off} required />
          <Text id={`${uid}-rd`} label="Registered on" type="date" value={d.registrationDate} onChange={(v) => set('registrationDate', v)} problem={err(problems, 'registrationDate')} disabled={off} required />
          <Text id={`${uid}-tx`} label="Tax ID (KRA PIN)" value={d.taxId} onChange={(v) => set('taxId', v)} problem={err(problems, 'taxId')} disabled={off} required />
          <Text id={`${uid}-vt`} label="VAT number" value={d.vatNo} onChange={(v) => set('vatNo', v)} disabled={off} />
          <Text id={`${uid}-em`} label="Number of employees" value={d.employeeCount} onChange={(v) => set('employeeCount', v)} problem={err(problems, 'employeeCount')} disabled={off} />
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="checkbox" className="h-5 w-5" checked={d.taxExempt} onChange={(e) => set('taxExempt', e.target.checked)} disabled={off} />My business is tax exempt</label>
        {off ? null : <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
      </form>

      <section className={`${cardClass} space-y-3`} aria-label="Owners and directors">
        <h3 className="text-sm font-bold text-fg-strong">Owners and directors</h3>
        <Message notice={director.notice} />
        {form.directors.length === 0 ? <p className="text-sm text-fg-muted">Nobody added yet. Add at least one owner or director.</p> : (
          <ul className="divide-y divide-line text-sm">
            {form.directors.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-semibold text-fg-strong">{x.name}</span> <span className="text-fg-muted">{ID_TYPES.find((t) => t.id === x.idType)?.label ?? x.idType} ending {x.idLast4}{x.sharePercent === '' ? '' : ` · ${x.sharePercent}%`}</span></span>
                {off ? null : <button type="button" className={buttonClass} disabled={director.busy} onClick={() => void director.save(removeDirectorAction(x.id), 'Removed.')} aria-label={`Remove ${x.name}`}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        {off ? null : (
          <form onSubmit={(e) => { e.preventDefault(); void director.save(addDirectorAction(dir), 'Added.').then((ok) => { if (ok) setDir({ name: '', idType: 'national_id', idNumber: '', sharePercent: '' }); }); }} noValidate className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Add an owner or director">
            <Text id={`${uid}-dn`} label="Name" value={dir.name} onChange={(v) => setDir((p) => ({ ...p, name: v }))} problem={err(director.problems, 'directors.0.name')} disabled={false} required />
            <ChoicePicker label="Kind of ID" source="vendor-id-types" choice={optionOf(ID_TYPES, dir.idType)} onChoice={(c) => setDir((p) => ({ ...p, idType: c?.id ?? 'national_id' }))} clearable={false} />
            <Text id={`${uid}-di`} label="ID number" value={dir.idNumber} onChange={(v) => setDir((p) => ({ ...p, idNumber: v }))} problem={err(director.problems, 'directors.0.idNumber')} disabled={false} required hint="Kept sealed. Only the last four digits are shown." />
            <Text id={`${uid}-ds`} label="Share of the business (%)" value={dir.sharePercent} onChange={(v) => setDir((p) => ({ ...p, sharePercent: v }))} problem={err(director.problems, 'directors.0.sharePercent')} disabled={false} />
            <div><button type="submit" className={buttonClass} disabled={director.busy}>{director.busy ? 'Adding…' : 'Add person'}</button></div>
          </form>
        )}
      </section>

      <section className={`${cardClass} space-y-3`} aria-label="References">
        <h3 className="text-sm font-bold text-fg-strong">References (optional)</h3>
        <p className="text-xs text-fg-muted">Clients you have supplied recently.</p>
        <Message notice={refs.notice} />
        {list.map((r, i) => (
          <fieldset key={r.k} className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-2" disabled={off}>
            <legend className="px-1 text-xs font-semibold text-fg-muted">Reference {i + 1}</legend>
            <Text id={`${uid}-r${String(i)}c`} label="Client" value={r.clientName} onChange={(v) => setRef(i, { clientName: v })} problem={err(refs.problems, `references.${String(i)}.clientName`)} disabled={off} required />
            <Text id={`${uid}-r${String(i)}w`} label="What you supplied" value={r.workDescription} onChange={(v) => setRef(i, { workDescription: v })} disabled={off} />
            <Text id={`${uid}-r${String(i)}v`} label="Value" value={r.valueAmount} onChange={(v) => setRef(i, { valueAmount: v })} problem={err(refs.problems, `references.${String(i)}.valueAmount`)} disabled={off} />
            <Text id={`${uid}-r${String(i)}y`} label="Year" value={r.year} onChange={(v) => setRef(i, { year: v })} problem={err(refs.problems, `references.${String(i)}.year`)} disabled={off} />
            <Text id={`${uid}-r${String(i)}n`} label="Contact at the client" value={r.contactName} onChange={(v) => setRef(i, { contactName: v })} disabled={off} />
            <Text id={`${uid}-r${String(i)}p`} label="Their phone" type="tel" value={r.contactPhone} onChange={(v) => setRef(i, { contactPhone: v })} problem={err(refs.problems, `references.${String(i)}.contactPhone`)} disabled={off} />
            {off ? null : <div><button type="button" className={buttonClass} onClick={() => setList((l) => l.filter((_, j) => j !== i))} aria-label={`Remove reference ${String(i + 1)}`}>Remove reference</button></div>}
          </fieldset>
        ))}
        {off ? null : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setList((l) => [...l, { k: crypto.randomUUID(), clientName: '', workDescription: '', valueAmount: '', contactName: '', contactPhone: '', year: '' }])}>Add a reference</button>
            <button type="button" className={primaryClass} disabled={refs.busy} onClick={() => void refs.save(saveReferencesAction(list.map(({ k: _k, ...r }) => r)), 'References saved.')}>{refs.busy ? 'Saving…' : 'Save references'}</button>
          </div>
        )}
      </section>
    </div>
  );
}

function FinancialSection({ form }: { form: Form }) {
  const uid = useId();
  const { busy, notice, problems, save } = useSave();
  const bank = useSave();
  const [d, setD] = useState<FinancialData>(form.financial);
  const [b, setB] = useState({ bankName: '', branch: '', accountName: '', accountNumber: '', swift: '', kind: 'bank', reference: '' });
  const set = <K extends keyof FinancialData>(k: K, v: FinancialData[K]) => setD((p) => ({ ...p, [k]: v }));
  const off = !form.canEdit;
  return (
    <div className="space-y-5">
      <section className={`${cardClass} space-y-3`} aria-label="Bank accounts">
        <h3 className="text-sm font-bold text-fg-strong">Bank accounts</h3>
        <Message notice={bank.notice} />
        {form.banks.length === 0 ? <p className="text-sm text-fg-muted">No bank account yet. Add the account we will pay into.</p> : (
          <ul className="divide-y divide-line text-sm">
            {form.banks.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-semibold text-fg-strong">{x.bankName}, {x.branch}</span> <span className="text-fg-muted">{x.accountName} {maskAccount(x.last4)}</span></span>
                <span className="flex items-center gap-2">{x.status === 'draft' ? <Chip tone="gray">Not yet approved</Chip> : <Chip tone="green">In use</Chip>}{off || x.status !== 'draft' ? null : <button type="button" className={buttonClass} disabled={bank.busy} onClick={() => void bank.save(removeBankAction(x.id), 'Removed.')} aria-label={`Remove ${x.bankName} account ending ${x.last4}`}>Remove</button>}</span>
              </li>
            ))}
          </ul>
        )}
        {off ? <p className="text-xs text-fg-muted">To change where you are paid, use the request below.</p> : (
          <form onSubmit={(e) => { e.preventDefault(); void bank.save(addBankAction(b), 'Bank account added.').then((ok) => { if (ok) setB({ bankName: '', branch: '', accountName: '', accountNumber: '', swift: '', kind: 'bank', reference: '' }); }); }} noValidate className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Add a bank account">
            <ChoicePicker label="Where we pay" source="vendor-destination-kinds" choice={optionOf(DESTINATION_KINDS, b.kind)} onChoice={(c) => setB((p) => ({ ...p, kind: c?.id ?? 'bank' }))} clearable={false} />
            {b.kind === 'bank' ? <Text id={`${uid}-bn`} label="Bank" value={b.bankName} onChange={(v) => setB((p) => ({ ...p, bankName: v }))} problem={err(bank.problems, 'banks.0.bankName')} disabled={false} required /> : null}
            {b.kind === 'bank' ? <Text id={`${uid}-bb`} label="Branch" value={b.branch} onChange={(v) => setB((p) => ({ ...p, branch: v }))} problem={err(bank.problems, 'banks.0.branch')} disabled={false} required /> : null}
            <Text id={`${uid}-ba`} label={b.kind === 'bank' ? 'Account name' : 'Name registered with M-Pesa'} value={b.accountName} onChange={(v) => setB((p) => ({ ...p, accountName: v }))} problem={err(bank.problems, 'banks.0.accountName')} disabled={false} required />
            <Text id={`${uid}-bu`} label={numberLabel(b.kind)} value={b.accountNumber} onChange={(v) => setB((p) => ({ ...p, accountNumber: v }))} problem={err(bank.problems, 'banks.0.accountNumber')} disabled={false} required hint="Kept sealed. Only the last four digits are shown afterwards." />
            {b.kind === 'mpesa_paybill' || b.kind === 'mpesa_till' ? <Text id={`${uid}-br`} label={b.kind === 'mpesa_paybill' ? 'Account number to quote' : 'Reference (optional)'} value={b.reference} onChange={(v) => setB((p) => ({ ...p, reference: v }))} problem={err(bank.problems, 'banks.0.reference')} disabled={false} required={b.kind === 'mpesa_paybill'} /> : null}
            {b.kind === 'bank' ? <Text id={`${uid}-bs`} label="SWIFT code (foreign banks)" value={b.swift} onChange={(v) => setB((p) => ({ ...p, swift: v }))} problem={err(bank.problems, 'banks.0.swift')} disabled={false} /> : null}
            <div className="flex items-end"><button type="submit" className={buttonClass} disabled={bank.busy}>{bank.busy ? 'Adding…' : 'Add bank account'}</button></div>
          </form>
        )}
      </section>

      <form onSubmit={(e) => { e.preventDefault(); void save(saveFinancialAction(d), 'Saved.'); }} noValidate className={`${cardClass} space-y-4`} aria-label="Payment terms">
        <Message notice={notice} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Text id={`${uid}-pt`} label="Payment terms you offer (days)" value={d.offeredPaymentTermDays} onChange={(v) => set('offeredPaymentTermDays', v)} problem={err(problems, 'offeredPaymentTermDays')} disabled={off} />
          <ChoicePicker label="Yearly turnover" source="vendor-turnover-bands" choice={optionOf(TURNOVER_BANDS, d.turnoverBand)} onChoice={(c) => set('turnoverBand', c?.id ?? '')} placeholder="Choose a band" disabled={off} />
          <Text id={`${uid}-mm`} label="Mobile money number (optional)" type="tel" value={d.mobileMoneyNumber} onChange={(v) => set('mobileMoneyNumber', v)} problem={err(problems, 'mobileMoneyNumber')} disabled={off} />
        </div>
        {off ? null : <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
      </form>
    </div>
  );
}

function ContactsSection({ form }: { form: Form }) {
  const uid = useId();
  const { busy, notice, problems, save } = useSave();
  const blank = (primary: boolean): ContactInput => ({ name: '', role: 'management', email: '', phone: '', isPrimary: primary });
  const [list, setList] = useState<(ContactInput & { k: string })[]>(() => (form.contacts.length === 0 ? [blank(true)] : form.contacts).map((c) => ({ ...c, k: crypto.randomUUID() })));
  const off = !form.canEdit;
  const patch = (i: number, p: Partial<ContactInput>) => setList((l) => l.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const makeMain = (i: number) => setList((l) => l.map((c, j) => ({ ...c, isPrimary: j === i })));
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(saveContactsAction(list.map(({ k: _k, ...c }) => c)), 'Saved.'); }} noValidate className="space-y-4" aria-label="Contact persons">
      <Message notice={notice} />
      {err(problems, 'contacts') === undefined ? null : <p role="alert" className="text-sm text-red-600">{err(problems, 'contacts')}</p>}
      {list.map((c, i) => (
        <fieldset key={c.k} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2`} disabled={off}>
          <legend className="px-1 text-xs font-semibold text-fg-muted">Contact {i + 1}{c.isPrimary ? ' · main contact' : ''}</legend>
          <Text id={`${uid}-n${String(i)}`} label="Name" value={c.name} onChange={(v) => patch(i, { name: v })} problem={err(problems, `contacts.${String(i)}.name`)} disabled={off} required autoComplete="name" />
          <ChoicePicker label="Role" source="vendor-contact-roles" choice={optionOf(CONTACT_ROLES, c.role)} onChoice={(x) => patch(i, { role: x?.id ?? 'management' })} clearable={false} disabled={off} />
          <Text id={`${uid}-e${String(i)}`} label="Email" type="email" value={c.email} onChange={(v) => patch(i, { email: v })} problem={err(problems, `contacts.${String(i)}.email`)} disabled={off} required autoComplete="email" />
          <Text id={`${uid}-p${String(i)}`} label="Phone" type="tel" value={c.phone} onChange={(v) => patch(i, { phone: v })} problem={err(problems, `contacts.${String(i)}.phone`)} disabled={off} required autoComplete="tel" />
          {off ? null : (
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="radio" name={`${uid}-main`} className="h-5 w-5" checked={c.isPrimary} onChange={() => makeMain(i)} />Main contact</label>
              {list.length > 1 ? <button type="button" className={dangerClass} onClick={() => setList((l) => { const next = l.filter((_, j) => j !== i); return next.some((x) => x.isPrimary) ? next : next.map((x, j) => ({ ...x, isPrimary: j === 0 })); })} aria-label={`Remove contact ${String(i + 1)}`}>Remove</button> : null}
            </div>
          )}
        </fieldset>
      ))}
      {off ? null : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => setList((l) => [...l, { ...blank(false), k: crypto.randomUUID() }])}>Add another contact</button>
          <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </form>
  );
}

const DOC_TONE = { submitted: 'sky', valid: 'green', invalid: 'red', expired: 'red', replaced: 'gray' } as const;
const DOC_WORDS = { submitted: 'Waiting for our check', valid: 'Verified', invalid: 'Not accepted', expired: 'Expired', replaced: 'Replaced' } as const;

function AttachmentsSection({ form }: { form: Form }) {
  const router = useRouter();
  const [busyType, setBusyType] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const off = !form.canEdit;

  const upload = async (typeId: string, file: File) => {
    setBusyType(typeId);
    setNotice(null);
    const body = new FormData();
    body.set('file', file);
    body.set('documentTypeId', typeId);
    body.set('expiresOn', expiry[typeId] ?? '');
    try {
      const response = await fetch('/api/vendor/documents', { method: 'POST', body });
      const result = (await response.json()) as { ok: boolean; error?: string };
      setNotice(result.ok ? { kind: 'ok', text: 'Uploaded. We will check it.' } : { kind: 'error', text: result.error ?? 'The upload failed. Please try again.' });
      if (result.ok) router.refresh();
    } catch {
      setNotice({ kind: 'error', text: 'The upload failed. Check your connection and try again.' });
    } finally {
      setBusyType(null);
      const input = inputs.current[typeId];
      if (input) input.value = '';
    }
  };
  const remove = async (id: string) => {
    setNotice(null);
    const res = await attempt(removeDocumentAction(id));
    setNotice(res.ok ? { kind: 'ok', text: 'Removed.' } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-3">
      <Message notice={notice} />
      <p className="text-xs text-fg-muted">PDF files and JPEG, PNG or WebP pictures, up to 10 MB each. A newer upload replaces the older one.</p>
      <ul className="space-y-3" aria-label="Documents">
        {form.documents.map((d) => (
          <li key={d.typeId} className={`${cardClass} space-y-2`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-bold text-fg-strong">{d.name}{d.required ? '' : ' (optional)'}</span>
              {d.current === null ? <Chip tone={d.required ? 'amber' : 'gray'}>Not uploaded</Chip> : <Chip tone={DOC_TONE[d.current.status]}>{DOC_WORDS[d.current.status]}</Chip>}
            </div>
            {d.current === null ? null : (
              <p className="text-xs text-fg-muted">
                <a href={`/api/vendor/files/${d.current.fileId}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-600 hover:underline">{d.current.fileName}</a>
                {d.current.expiresOn === null ? '' : ` · expires ${d.current.expiresOn}`}{d.current.note === null ? '' : ` · ${d.current.note}`}
              </p>
            )}
            {off ? null : (
              <div className="flex flex-wrap items-end gap-3">
                {d.needsExpiry ? (
                  <div>
                    <label htmlFor={`exp-${d.typeId}`} className="block text-xs font-semibold text-fg-muted">Expiry date</label>
                    <input id={`exp-${d.typeId}`} type="date" value={expiry[d.typeId] ?? ''} onChange={(e) => setExpiry((x) => ({ ...x, [d.typeId]: e.target.value }))} className={fieldClass} />
                  </div>
                ) : null}
                <div>
                  <label htmlFor={`file-${d.typeId}`} className="block text-xs font-semibold text-fg-muted">{d.current === null ? 'Choose a file' : 'Replace with a newer file'}</label>
                  <input id={`file-${d.typeId}`} ref={(el) => { inputs.current[d.typeId] = el; }} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busyType !== null} onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void upload(d.typeId, f); }} className="block min-h-10 text-sm" />
                </div>
                {d.current !== null && d.current.status !== 'valid' ? <button type="button" className={buttonClass} onClick={() => void remove(d.current?.id ?? '')} aria-label={`Remove ${d.name}`}>Remove</button> : null}
                {busyType === d.typeId ? <span role="status" className="text-xs text-fg-muted">Uploading…</span> : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
