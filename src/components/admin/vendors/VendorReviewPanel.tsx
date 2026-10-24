'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveVendorAction, rejectVendorAction, requestRevisionAction, startReviewAction, type vendorReviewAction, verifyDocumentAction } from '@/server/domains/vendors/review-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CONTACT_ROLES, ID_TYPES, TURNOVER_BANDS, maskAccount } from '@/lib/vendor-profile';
import { VENDOR_TYPES } from '@/lib/vendor-forms';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorReviewAction>>, { ok: true }>['data'];
type Panel = null | 'approve' | 'revision' | 'reject';

const DOC_TONE = { submitted: 'sky', valid: 'green', invalid: 'red', expired: 'red', replaced: 'gray' } as const;
const DOC_WORDS = { submitted: 'Waiting for a check', valid: 'Valid', invalid: 'Not valid', expired: 'Expired', replaced: 'Replaced' } as const;
const DECISION_WORDS = { pending: 'Waiting for a decision', approved: 'Approved', revision_requested: 'Sent back for revision', rejected: 'Refused' } as const;
const label = (list: readonly { id: string; label: string }[], id: string): string => list.find((x) => x.id === id)?.label ?? id;
const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? '—' : v);
const when = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());

export function VendorReviewSection({ vendorId, reviewPromise }: { vendorId: string; reviewPromise: ReturnType<typeof vendorReviewAction> }) {
  const res = use(reviewPromise);
  return res.ok ? <VendorReviewPanel vendorId={vendorId} view={res.data} /> : <LoadFailed error={res.error} />;
}

function Facts({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section aria-label={title} className={cardClass}>
      <h4 className="text-sm font-bold text-fg-strong">{title}</h4>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="text-xs text-fg-muted">{k}</dt><dd className="font-medium text-fg-strong break-words">{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function VendorReviewPanel({ vendorId, view }: { vendorId: string; view: View }) {
  const uid = useId();
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState('');

  const waiting = view.status === 'profile_submitted' || view.status === 'under_review';
  const finish = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: ok });
    setPanel(null);
    setVerifying(null);
    router.refresh();
  };
  const act = async (call: Promise<{ ok: true } | { ok: false; error: string }>, ok: string) => {
    setBusy(true);
    setNotice(null);
    finish(await attempt(call), ok);
  };
  const needsReasonComment = reason?.meta?.requiresComment === '1';

  const renderVerify = (typeName: string, docId: string, status: 'submitted' | 'valid' | 'invalid') => {
    if (verifying === docId) {
      return (
        <form className="flex flex-wrap items-end gap-2" aria-label={`Mark ${typeName} not valid`} onSubmit={(e) => { e.preventDefault(); void act(verifyDocumentAction(docId, 'invalid', verifyNote), 'The document is marked not valid.'); }}>
          <Field id={`${uid}-v-${docId}`} label="What is wrong with it?"><input id={`${uid}-v-${docId}`} value={verifyNote} onChange={(e) => setVerifyNote(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
          <button type="submit" className={dangerClass} disabled={busy}>Mark not valid</button>
          <button type="button" className={buttonClass} onClick={() => setVerifying(null)}>Cancel</button>
        </form>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        {status === 'valid' ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(verifyDocumentAction(docId, 'valid', ''), 'The document is marked valid.')} aria-label={`Mark ${typeName} valid`}>Mark valid</button>}
        {status === 'invalid' ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => { setVerifying(docId); setVerifyNote(''); }} aria-label={`Mark ${typeName} not valid`}>Not valid…</button>}
      </div>
    );
  };

  const p = view.profile;
  const b = view.business;
  const f = view.financial;

  return (
    <div className="space-y-4">
      <section aria-label="Application" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-fg-strong">Application</h3>
          <span className="text-xs text-fg-muted">{view.submittedAt === null ? 'The vendor has not sent its profile yet.' : `Sent ${when(view.submittedAt)}`}</span>
        </div>
        <Message notice={notice} />
        {waiting ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {view.status === 'profile_submitted' && view.can.review ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(startReviewAction(vendorId), 'You have taken this profile for review.')}>Take for review</button> : null}
            {view.can.approve ? <button type="button" className={primaryClass} disabled={busy} onClick={() => setPanel('approve')}>Approve</button> : null}
            {view.can.requestRevision ? <button type="button" className={buttonClass} disabled={busy} onClick={() => setPanel('revision')}>Send back for revision</button> : null}
            {view.can.reject ? <button type="button" className={dangerClass} disabled={busy} onClick={() => setPanel('reject')}>Refuse</button> : null}
          </div>
        ) : null}
        {panel === 'approve' ? (
          <div className="mt-3 space-y-2 rounded-lg border border-line p-3" role="group" aria-label="Approve this vendor">
            <p className="text-sm text-fg">Approving makes the vendor active, gives it a vendor number and puts its bank accounts into use. Every required document must be marked valid first.</p>
            <div className="flex gap-2"><button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveVendorAction(vendorId), 'The vendor is approved and active.')}>Approve this vendor</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Not yet</button></div>
          </div>
        ) : null}
        {panel === 'revision' ? (
          <form className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label="Send back for revision" onSubmit={(e) => { e.preventDefault(); void act(requestRevisionAction(vendorId, notes, comment), 'Sent back to the vendor.'); }}>
            <p className="text-sm text-fg">Say what to fix in each section that needs work. Sections you leave empty are accepted as they are.</p>
            {view.sections.map((s) => (
              <Field key={s.id} id={`${uid}-n-${s.id}`} label={s.label}>
                <input id={`${uid}-n-${s.id}`} value={notes[s.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))} className={fieldClass} maxLength={1000} autoComplete="off" />
              </Field>
            ))}
            <Field id={`${uid}-rc`} label="Message to the vendor (optional)">
              <input id={`${uid}-rc`} value={comment} onChange={(e) => setComment(e.target.value)} className={fieldClass} maxLength={500} autoComplete="off" />
            </Field>
            <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Send back</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
          </form>
        ) : null}
        {panel === 'reject' ? (
          <form className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label="Refuse this application" onSubmit={(e) => { e.preventDefault(); void act(rejectVendorAction(vendorId, { code: reason?.id ?? '', text: reasonText }), 'The application is refused.'); }}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoicePicker label="Reason" source="vendor-rejection-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
              <Field id={`${uid}-rt`} label={needsReasonComment ? 'Explain (required)' : 'Comment (optional)'} hint="Kept with your name and the time. The vendor is told the reason.">
                <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsReasonComment} maxLength={500} autoComplete="off" />
              </Field>
            </div>
            <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Refuse the application</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
          </form>
        ) : null}
      </section>

      {view.submittedAt === null && view.versions.length === 0 ? null : (
        <>
          <Facts title="Vendor profile" rows={[
            ['Kind of business', label(VENDOR_TYPES, p.vendorType)], ['Trading name', dash(p.tradingName)], ['Country', dash(p.country)], ['Year established', dash(p.yearEstablished)],
            ['Website', dash(p.website)], ['Phone', dash(p.phone)], ['Address', dash([p.physicalStreet, p.physicalCity, p.physicalCounty, p.physicalPostalCode].filter((x) => x !== '').join(', '))], ['Postal address', dash(p.postalAddress)],
            ['What they supply', dash(p.description)],
          ]} />
          <Facts title="Business information" rows={[
            ['Registration number', dash(b.registrationNo)], ['Registered on', dash(b.registrationDate)], ['Tax ID', dash(b.taxId)], ['VAT number', dash(b.vatNo)], ['Employees', dash(b.employeeCount)], ['Tax exempt', b.taxExempt ? 'Yes' : 'No'],
            ...view.directors.map((d): [string, string] => [`Director · ${d.name}`, `${label(ID_TYPES, d.idType)} ending ${d.idLast4}${d.share === null ? '' : ` · ${d.share}%`}`]),
            ...view.references.map((r): [string, string] => [`Reference · ${r.clientName}`, dash([r.workDescription, r.year, r.valueAmount].filter((x) => x !== '').join(' · '))]),
          ]} />
          <Facts title="Financial information" rows={[
            ['Payment terms offered', f.offeredPaymentTermDays === '' ? '—' : `${f.offeredPaymentTermDays} days`], ['Turnover', f.turnoverBand === '' ? '—' : label(TURNOVER_BANDS, f.turnoverBand)], ['Mobile money', dash(f.mobileMoneyNumber)],
            ...view.banks.map((x): [string, string] => [`Bank · ${x.bankName}, ${x.branch}`, `${x.accountName} ${maskAccount(x.last4)}${x.status === 'draft' ? ' (not yet in use)' : ''}`]),
          ]} />
          <Facts title="Contact persons" rows={view.contacts.map((c): [string, string] => [`${c.name}${c.isPrimary ? ' (main)' : ''}`, `${label(CONTACT_ROLES, c.role)} · ${c.email} · ${c.phone}`])} />

          <section aria-label="Documents" className={cardClass}>
            <h4 className="text-sm font-bold text-fg-strong">Documents</h4>
            <ul className="mt-2 divide-y divide-line text-sm">
              {view.documents.map((d) => (
                <li key={d.typeName} className="space-y-2 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-fg-strong">{d.typeName}{d.required ? '' : ' (optional)'}</span>
                    {d.doc === null ? <Chip tone={d.required ? 'amber' : 'gray'}>Not uploaded</Chip> : <Chip tone={DOC_TONE[d.doc.status]}>{DOC_WORDS[d.doc.status]}</Chip>}
                  </div>
                  {d.doc === null ? null : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                      {view.can.viewDocuments ? <a href={`/api/admin/vendors/files/${d.doc.fileId}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-600 hover:underline">{d.doc.fileName}</a> : <span>{d.doc.fileName}</span>}
                      <span>Uploaded {when(d.doc.uploadedAt)}</span>
                      {d.doc.expiresOn === null ? null : <span>Expires {d.doc.expiresOn}</span>}
                      {d.doc.note === null ? null : <span>Note: {d.doc.note}</span>}
                    </div>
                  )}
                  {d.doc !== null && view.can.verify && (d.doc.status === 'submitted' || d.doc.status === 'valid' || d.doc.status === 'invalid') ? renderVerify(d.typeName, d.doc.id, d.doc.status) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Earlier submissions" className={cardClass}>
            <h4 className="text-sm font-bold text-fg-strong">Submissions</h4>
            <ol className="mt-2 space-y-2 text-xs">
              {view.versions.map((x) => (
                <li key={x.version} className="border-t border-line pt-2 first:border-0 first:pt-0">
                  <p className="font-semibold text-fg-strong">Version {x.version} · {DECISION_WORDS[x.decision]}</p>
                  <p className="text-fg-muted">Sent {when(x.submittedAt)}{x.decidedAt === null ? '' : ` · decided ${when(x.decidedAt)}`}</p>
                  {x.reasonCode === null ? null : <p className="text-fg-muted">Reason: {x.reasonCode}</p>}
                  {x.comment === null ? null : <p className="text-fg">{x.comment}</p>}
                  {Object.entries(x.sectionNotes).map(([k, note]) => <p key={k} className="text-fg"><span className="font-semibold">{view.sections.find((s) => s.id === k)?.label ?? k}:</span> {note}</p>)}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
