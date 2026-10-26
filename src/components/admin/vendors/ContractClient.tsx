'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import {
  approveContractAction,
  callOffAction,
  cancelContractAction,
  closeContractAction,
  saveContractAction,
  sendBackContractAction,
  submitContractAction,
  type contractAction,
} from '@/server/domains/vendors/contract-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CONTRACT_STATUS, emptyContractLine, type ContractLineForm } from '@/lib/vendor-contract';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof contractAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };
const EVENT_WORDS: Record<string, string> = { created: 'Written', submitted: 'Sent for approval', approved: 'Approved', sent_back: 'Sent back', closed: 'Closed', cancelled: 'Cancelled' };

export function ContractClient({ viewPromise }: { viewPromise: ReturnType<typeof contractAction> }) {
  const res = use(viewPromise);
  return res.ok ? <View key={res.data.found?.contract.id ?? 'new'} data={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const found = data.found;
  const c = found?.contract ?? null;
  const mine = c === null || c.createdBy === data.me;
  const editing = data.can.create && mine && (c === null || c.status === 'draft');
  const [title, setTitle] = useState(c?.title ?? '');
  const [vendor, setVendor] = useState<Choice | null>(c === null || found === null ? null : { id: c.vendorId, label: found.vendor });
  const [category, setCategory] = useState<Choice | null>(c === null || found === null ? null : { id: c.categoryId, label: found.category });
  const [currency, setCurrency] = useState<Choice | null>(c === null ? null : { id: c.currency, label: c.currency });
  const [validFrom, setValidFrom] = useState(c?.validFrom ?? data.today);
  const [validTo, setValidTo] = useState(c?.validTo ?? '');
  const [maxValue, setMaxValue] = useState(c?.maxValue ?? '');
  const [terms, setTerms] = useState(c?.terms ?? '');
  const [rows, setRows] = useState<{ key: number; line: ContractLineForm }[]>((found === null ? [emptyContractLine()] : found.lines.map((l) => ({ productId: l.productId ?? '', description: l.description, specification: l.specification, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, maxQuantity: l.maxQuantity ?? '' }))).map((line, key) => ({ key, line })));
  const [nextKey, setNextKey] = useState(rows.length);
  const [text, setText] = useState('');
  const [take, setTake] = useState<Record<string, string>>({});
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const act = async (call: Promise<Result>, done: string, to?: (data: unknown) => string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: done });
    if (to !== undefined) router.push(to(res.data));
    else router.refresh();
  };
  const save = async (andSend: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveContractAction(c?.id ?? null, { vendorId: vendor?.id ?? '', categoryId: category?.id ?? '', title, currency: currency?.id ?? '', validFrom, validTo, maxValue, terms }, rows.map((x) => x.line)));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    if (andSend) {
      const sent = await attempt(submitContractAction(res.data.id));
      if (!sent.ok) setNotice({ kind: 'error', text: sent.error });
    }
    setBusy(false);
    if (c === null) router.push(`/admin/vendors/contracts/${res.data.id}`);
    else router.refresh();
  };
  const setLine = (i: number, patch: Partial<ContractLineForm>) => setRows((p) => p.map((x, k) => (k === i ? { ...x, line: { ...x.line, ...patch } } : x)));
  const addLine = () => {
    setRows((p) => [...p, { key: nextKey, line: emptyContractLine() }]);
    setNextKey((n) => n + 1);
  };
  const status = c === null ? null : CONTRACT_STATUS[c.status];
  const iWrote = c !== null && c.createdBy === data.me;
  const asked = found === null ? [] : found.lines.filter((l) => (take[l.id] ?? '').trim() !== '').map((l) => ({ contractLineId: l.id, quantity: take[l.id] ?? '' }));
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title={c === null ? 'New vendor contract' : `Contract ${c.number ?? '(draft)'}`} intro={<span className="flex flex-wrap items-center gap-2">{status === null ? null : <Chip tone={status.tone}>{status.label}</Chip>}{found === null ? null : <span>{found.vendor} · {c?.validFrom} to {c?.validTo}</span>}</span>} actions={<Link href="/admin/vendors/contracts" className={buttonClass}>All contracts</Link>} />
      <Message notice={notice} />
      {c?.rejectReason == null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Sent back: {c.rejectReason}</p>}
      <form className={`${cardClass} space-y-4`} aria-label="Contract" onSubmit={(e) => e.preventDefault()}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-t`} label="Title"><input id={`${uid}-t`} value={title} maxLength={150} disabled={!editing} onChange={(e) => setTitle(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <ChoicePicker label="Vendor" source="vendors" choice={vendor} onChoice={setVendor} disabled={!editing} required clearable={false} placeholder="Search by name or number" />
          <ChoicePicker label="Category" source="procurement-categories" choice={category} onChoice={setCategory} disabled={!editing} required clearable={false} placeholder="Choose the category…" />
          <ChoicePicker label="Currency" source="rfq-currencies" choice={currency} onChoice={setCurrency} disabled={!editing} required clearable={false} placeholder="Choose the currency…" />
          <Field id={`${uid}-f`} label="First day"><input id={`${uid}-f`} type="date" value={validFrom} disabled={!editing} onChange={(e) => setValidFrom(e.target.value)} className={fieldClass} /></Field>
          <Field id={`${uid}-v`} label="Last day"><input id={`${uid}-v`} type="date" value={validTo} disabled={!editing} onChange={(e) => setValidTo(e.target.value)} className={fieldClass} /></Field>
          <Field id={`${uid}-m`} label="Most all orders may come to (optional)" hint="With tax. Leave empty for no ceiling."><input id={`${uid}-m`} inputMode="decimal" value={maxValue} disabled={!editing} onChange={(e) => setMaxValue(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        </div>
        <Field id={`${uid}-tm`} label="Terms (optional)"><input id={`${uid}-tm`} value={terms} maxLength={4000} disabled={!editing} onChange={(e) => setTerms(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg">What is agreed</legend>
          {rows.map(({ key, line: l }, i) => (
            <div key={key} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-2 sm:grid-cols-6">
              <div className="sm:col-span-2"><Field id={`${uid}-d${String(key)}`} label={`Item ${String(i + 1)}`}><input id={`${uid}-d${String(key)}`} value={l.description} maxLength={300} disabled={!editing} onChange={(e) => setLine(i, { description: e.target.value })} className={fieldClass} autoComplete="off" /></Field></div>
              <Field id={`${uid}-u${String(key)}`} label={`Unit ${String(i + 1)}`}><input id={`${uid}-u${String(key)}`} value={l.unit} maxLength={20} disabled={!editing} onChange={(e) => setLine(i, { unit: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-p${String(key)}`} label={`Agreed price ${String(i + 1)}`}><input id={`${uid}-p${String(key)}`} inputMode="decimal" value={l.unitPrice} disabled={!editing} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-x${String(key)}`} label={`Tax % ${String(i + 1)}`}><input id={`${uid}-x${String(key)}`} inputMode="decimal" value={l.taxRate} disabled={!editing} onChange={(e) => setLine(i, { taxRate: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-q${String(key)}`} label={`Most to order ${String(i + 1)}`}><input id={`${uid}-q${String(key)}`} inputMode="decimal" value={l.maxQuantity} disabled={!editing} onChange={(e) => setLine(i, { maxQuantity: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              {editing && rows.length > 1 ? <button type="button" className={`${buttonClass} sm:col-span-6`} onClick={() => setRows((p) => p.filter((_, k) => k !== i))}>Remove item {i + 1}</button> : null}
            </div>
          ))}
          {editing ? <button type="button" className={buttonClass} onClick={addLine}>Add an item</button> : null}
        </fieldset>
        {editing ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void save(true)}>Send for approval</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(false)}>Save as a draft</button>
          </div>
        ) : null}
      </form>

      {c?.status === 'pending_approval' && data.can.approve ? (
        <section className={`${cardClass} space-y-2`} aria-label="Decide">
          {iWrote ? <p className="text-xs text-amber-700">You wrote this contract, so another person has to approve it.</p> : (
            <>
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveContractAction(c.id), 'Approved. The contract is in force.')}>Approve</button>
              <div className="flex flex-wrap items-end gap-2">
                <Field id={`${uid}-sb`} label="Or send it back, saying why"><input id={`${uid}-sb`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
                <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(sendBackContractAction(c.id, text), 'Sent back.')}>Send back</button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {found !== null && c?.status === 'active' ? (
        <section className={`${cardClass} space-y-3`} aria-label="What has been ordered">
          <h2 className="text-sm font-bold text-fg-strong">What has been ordered</h2>
          <p className="text-sm text-fg">Ordered so far: <span className="font-semibold tabular-nums">{found.usedValue} {c.currency}</span>{found.leftValue === null ? '' : ` · left under the ceiling: ${found.leftValue}`}</p>
          <ul className="divide-y divide-line text-sm" aria-label="Contract lines">
            {found.lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-end justify-between gap-2 py-2">
                <span className="min-w-0">{l.description}<span className="block text-xs text-fg-muted">{l.unitPrice} each · ordered {String(l.usedQuantity)}{l.remaining === null ? ', no limit' : `, ${String(l.remaining)} left`}</span></span>
                {data.can.callOff ? <Field id={`${uid}-take-${l.id}`} label={`Order of ${l.description}`}><input id={`${uid}-take-${l.id}`} inputMode="decimal" value={take[l.id] ?? ''} onChange={(e) => setTake((p) => ({ ...p, [l.id]: e.target.value }))} className={`${fieldClass} w-28`} autoComplete="off" /></Field> : null}
              </li>
            ))}
          </ul>
          {data.can.callOff ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field id={`${uid}-ed`} label="Needed by (optional)"><input id={`${uid}-ed`} type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className={fieldClass} /></Field>
              <button type="button" className={primaryClass} disabled={busy || asked.length === 0} onClick={() => void act(callOffAction(c.id, asked, expectedDate, ''), 'The order is written as a draft at the contract’s prices.', (d) => `/admin/vendors/orders/${(d as { id: string }).id}`)}>Order from this contract</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {c !== null && (c.status === 'active' || c.status === 'draft' || c.status === 'pending_approval') && ((c.status === 'active' && data.can.close) || (c.status !== 'active' && data.can.create && iWrote)) ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="End the contract">
          <Field id={`${uid}-cx`} label={c.status === 'active' ? 'Why is it closed?' : 'Why cancel it?'}><input id={`${uid}-cx`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(c.status === 'active' ? closeContractAction(c.id, text) : cancelContractAction(c.id, text), c.status === 'active' ? 'Closed. No more orders can be called off.' : 'Cancelled.')}>{c.status === 'active' ? 'Close the contract' : 'Cancel the contract'}</button>
        </section>
      ) : null}

      {found === null ? null : (
        <section className={cardClass} aria-label="History">
          <h2 className="text-sm font-bold text-fg-strong">History</h2>
          <ol className="mt-1 space-y-1 text-sm text-fg">{found.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}</ol>
        </section>
      )}
    </div>
  );
}
