'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { landedPreviewAction, saveLandedCostAction } from '@/server/domains/vendors/landed-cost-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Preview = Extract<Awaited<ReturnType<typeof landedPreviewAction>>, { ok: true }>['data'];

export function LandedCostEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof landedPreviewAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Editor first={res.data} /> : <LoadFailed error={res.error} />;
}

function Editor({ first }: { first: Preview }) {
  const uid = useId();
  const router = useRouter();
  const [kind, setKind] = useState<Choice | null>(null);
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Choice | null>({ id: 'value', label: 'By the value of the goods' });
  const [preview, setPreview] = useState<Preview>(first);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const refresh = async (nextAmount: string, nextMethod: string) => {
    const res = await attempt(landedPreviewAction(first.note.id, nextAmount, nextMethod));
    if (res.ok) setPreview(res.data);
  };
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveLandedCostAction(null, first.note.id, { kind: kind?.id ?? '', description, reference, amount, method: method?.id ?? 'value' }));
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else router.push(`/admin/vendors/landed-costs/${res.data.id}`);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Add a charge to goods" intro={`Spread over the stock lines of received goods note ${first.note.number ?? ''}. Another person posts it, which raises what the goods in stock cost.`} actions={<Link href={`/admin/vendors/receipts/${first.note.id}`} className={buttonClass}>Back to the note</Link>} />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-4`} aria-label="Landed cost" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoicePicker label="Kind of charge" source="landed-cost-kinds" choice={kind} onChoice={setKind} required clearable={false} placeholder="Freight, duty…" />
          <Field id={`${uid}-d`} label="What it is"><input id={`${uid}-d`} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <Field id={`${uid}-r`} label="Number of the invoice or document"><input id={`${uid}-r`} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <Field id={`${uid}-a`} label="Amount"><input id={`${uid}-a`} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); void refresh(e.target.value, method?.id ?? 'value'); }} className={fieldClass} autoComplete="off" /></Field>
          <ChoicePicker label="Spread" source="landed-cost-methods" choice={method} onChoice={(c) => { setMethod(c); void refresh(amount, c?.id ?? 'value'); }} required clearable={false} />
        </div>
        <ul className="divide-y divide-line text-sm" aria-label="How it would be spread">
          {preview.lines.map((l) => <li key={l.rgnLineId} className="flex flex-wrap justify-between gap-2 py-2"><span>{l.description} <span className="text-xs text-fg-muted">{String(l.quantity)} {l.unit}</span></span><span className="font-semibold tabular-nums">{l.share}</span></li>)}
        </ul>
        <button type="submit" className={primaryClass} disabled={busy || kind === null}>Save the charge</button>
      </form>
    </div>
  );
}

