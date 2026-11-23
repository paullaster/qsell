'use client';

import { use, useId, useState } from 'react';
import { resetSellingSettingsAction, saveSellingSettingsAction, type sellingSettingsScreenAction } from '@/server/domains/selling/actions';
import type { SellingTypeView } from '@/server/domains/selling/selling-settings-service';
import { ENUM_SETTINGS, OPTION_WORDS, type EnumSetting, type SellingSettings } from '@/server/domains/selling/selling-documents';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof sellingSettingsScreenAction>>;

const TITLES: Record<EnumSetting, string> = {
  creditCheck: 'Credit check',
  noAccount: 'Customer without a credit account',
  overLimit: 'When over the limit',
  creditDays: 'Credit days',
  stockRelease: 'Stock is released',
  approval: 'Approval',
  invoice: 'The invoice is made',
  discounts: 'Discounts',
  manualDiscount: 'Discount typed by staff',
};

export function SellingSettingsClient({ firstPromise }: { firstPromise: ReturnType<typeof sellingSettingsScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

const wordsOf = (name: EnumSetting, id: string): string => OPTION_WORDS[name][id]?.label ?? id;

function Body({ initial }: { initial: SellingTypeView[] }) {
  const [types, setTypes] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Selling documents" intro="Choose how each kind of sale behaves: whether credit is checked and for how many days, when the stock leaves, whether it needs approval, and when the invoice is made. Until you change one, it works as built in." />
      <Message notice={notice} />
      <ul className="space-y-3">
        {types.map((t) => (
          <li key={t.type} className={cardClass}>
            {editing === t.type ? (
              <Editor
                type={t}
                onCancel={() => setEditing(null)}
                onSaved={(next, text) => {
                  setTypes(next);
                  setEditing(null);
                  setNotice({ kind: 'ok', text });
                }}
              />
            ) : (
              <Summary type={t} onChange={() => { setNotice(null); setEditing(t.type); }} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Summary({ type, onChange }: { type: SellingTypeView; onChange: () => void }) {
  const s = type.settings;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-fg-strong">{type.label}</h2>
          <p className="text-xs text-fg-muted">{type.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={type.configured ? 'sky' : 'gray'}>{type.configured ? 'Changed' : 'As built in'}</Chip>
          <button type="button" className={buttonClass} aria-label={`Change ${type.label}`} onClick={onChange}>Change</button>
        </div>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[14rem_1fr]">
        {ENUM_SETTINGS.map((name) => (
          <div key={name} className="contents">
            <dt className="text-fg-muted">{TITLES[name]}</dt>
            <dd className="min-w-0 break-words text-fg">
              {wordsOf(name, s[name])}
              {name === 'creditCheck' && s.creditCheck === 'limit_and_overdue' ? ` (more than ${String(s.overdueDays)} days)` : ''}
              {name === 'creditDays' && s.creditDays === 'fixed' ? ` (${String(s.fixedDays)} days)` : ''}
            </dd>
          </div>
        ))}
        {s.manualDiscount === 'selected_branches' ? <div className="contents"><dt className="text-fg-muted">Discount offered at</dt><dd className="min-w-0 break-words text-fg">{type.branches.map((b) => b.name).join(', ')}</dd></div> : null}
        {s.invoice === 'with_document' && s.approval === 'workflow' ? <div className="contents"><dt className="text-fg-muted">Invoice after approval</dt><dd className="text-fg">{s.invoiceAfterApproval ? 'Made automatically once approved' : 'Staff raise it after approval'}</dd></div> : null}
        <div className="contents"><dt className="text-fg-muted">Hold until paid</dt><dd className="text-fg">{s.allowHoldUntilPaid ? 'Staff may hold a document until it is paid' : 'Not offered'}</dd></div>
      </dl>
    </div>
  );
}

function Editor({ type, onCancel, onSaved }: { type: SellingTypeView; onCancel: () => void; onSaved: (types: SellingTypeView[], text: string) => void }) {
  const uid = useId();
  const [values, setValues] = useState<SellingSettings>(type.settings);
  const [branchNames, setBranchNames] = useState<Record<string, string>>(() => Object.fromEntries(type.branches.map((b) => [b.id, b.name])));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof SellingSettings>(key: K, value: SellingSettings[K]) => setValues((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(saveSellingSettingsAction(type.type, values, reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, 'Saved. It applies to the next document.');
    else setProblem(r.error);
  };
  const reset = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(resetSellingSettingsAction(type.type, reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, 'Put back to how it was built in.');
    else setProblem(r.error);
  };
  const days = (id: string, label: string, key: 'overdueDays' | 'fixedDays') => (
    <Field id={id} label={label}>
      <input id={id} type="number" min={0} max={365} step={1} className={fieldClass} value={values[key]} onChange={(e) => set(key, Math.trunc(Number(e.target.value)))} />
    </Field>
  );
  return (
    <form aria-label={`Change ${type.label}`} className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div>
        <h2 className="text-sm font-bold text-fg-strong">{type.label}</h2>
        <p className="text-xs text-fg-muted">{type.description}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {ENUM_SETTINGS.map((name) => (
          <ChoicePicker
            key={name}
            label={TITLES[name]}
            source="selling-setting-options"
            filters={{ setting: name, type: type.type }}
            clearable={false}
            choice={{ id: values[name], label: wordsOf(name, values[name]) }}
            onChoice={(c) => c !== null && setValues((v) => ({ ...v, [name]: c.id }))}
          />
        ))}
        {values.manualDiscount === 'selected_branches' ? (
          <div className="sm:col-span-2" data-testid="discount-branches">
            <ChoicePicker label="Add a branch where a discount may be offered" source="selling-branches" choice={null} placeholder="Search a branch…" onChoice={(c) => { if (c === null) return; setBranchNames((n) => ({ ...n, [c.id]: c.label })); setValues((v) => ({ ...v, manualDiscountBranches: v.manualDiscountBranches.includes(c.id) ? v.manualDiscountBranches : [...v.manualDiscountBranches, c.id] })); }} />
            {values.manualDiscountBranches.length === 0 ? <p className="mt-2 text-xs text-fg-muted">No branch chosen yet.</p> : (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Branches where a discount may be offered">
                {values.manualDiscountBranches.map((id) => (
                  <li key={id} className="inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface pl-3 text-sm text-fg">
                    <span className="break-words">{branchNames[id] ?? 'Branch'}</span>
                    <button type="button" className="inline-flex size-10 items-center justify-center rounded-full text-fg-muted hover:bg-hover" aria-label={`Remove ${branchNames[id] ?? 'this branch'}`} onClick={() => setValues((v) => ({ ...v, manualDiscountBranches: v.manualDiscountBranches.filter((x) => x !== id) }))}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {values.creditCheck === 'limit_and_overdue' ? days(`${uid}-overdue`, 'An invoice overdue by more than (days)', 'overdueDays') : null}
        {values.creditDays === 'fixed' ? days(`${uid}-fixed`, 'Credit days for every customer', 'fixedDays') : null}
      </div>
      {values.invoice === 'with_document' && values.approval === 'workflow' ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={values.invoiceAfterApproval} onChange={(e) => set('invoiceAfterApproval', e.target.checked)} />
          If approval holds the document, make its invoice automatically once it is approved
        </label>
      ) : null}
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={values.allowHoldUntilPaid} disabled={type.type === 'pos_cash_sale'} onChange={(e) => set('allowHoldUntilPaid', e.target.checked)} />
        Staff may switch on &quot;Hold until paid&quot; for a single document (stock is kept until payment is received)
      </label>
      <ReasonField value={reason} onChange={setReason} source="selling-reasons" />
      <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryClass} disabled={busy || reason.code === ''}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {type.configured ? <InlineConfirm label={`Put ${type.label} back to how it was built in`} action="Put back as built in" confirm="Yes, put it back" busy={busy || reason.code === ''} onConfirm={() => void reset()} /> : null}
      </div>
      {reason.code === '' ? <p className="text-xs text-fg-muted">Choose a reason to save.</p> : null}
    </form>
  );
}
