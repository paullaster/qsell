'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  approveStockTransferAction,
  cancelStockTransferAction,
  receiveStockTransferAction,
  requestStockTransferAction,
  resolveStockTransferAction,
  shipStockTransferAction,
  type stockTransferAction,
  type TransferDetail,
} from '@/server/domains/stock/transfer-actions';
import { TransferForm } from './TransferForm';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, LoadFailed, Message, PageHeader, Chip, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { TRANSFER_STATE_WORDS, isTransferState } from '@/lib/stock-documents';
import type { Choice } from '@/lib/payment-options';

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const number = (text: string): number => (text.trim() === '' ? 0 : Number(text.trim()));

export function TransferDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof stockTransferAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail t={res.data} /> : <LoadFailed error={res.error} />;
}

type Quantities = Record<string, string>;

function Detail({ t }: { t: TransferDetail }) {
  const uid = useId();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState('');
  const [ship, setShip] = useState<Quantities>(() => Object.fromEntries(t.lines.map((l) => [l.id, String(l.quantity)])));
  const [arrived, setArrived] = useState<Quantities>(() => Object.fromEntries(t.lines.map((l) => [l.id, l.inTransit > 0 ? String(l.inTransit) : ''])));
  const [lost, setLost] = useState<Quantities>({});
  const [settlement, setSettlement] = useState<Choice | null>(null);
  const [why, setWhy] = useState('');

  const words = isTransferState(t.state) ? TRANSFER_STATE_WORDS[t.state] : { label: t.state, tone: 'gray' as const };
  const onItsWay = t.state === 'shipped' || t.state === 'partly_received';
  const waitingToSend = t.state === 'requested' || t.state === 'approved';
  const needsApprovalFirst = t.approvalRequired && t.state === 'requested';

  const run = async (call: Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (res.ok) {
      setNotice({ kind: 'ok', text: success });
      router.refresh();
    } else {
      setNotice({ kind: 'error', text: res.error ?? 'Something went wrong. Please try again.' });
    }
  };
  const entries = (q: Quantities) => t.lines.map((l) => ({ lineId: l.id, quantity: number(q[l.id] ?? '') })).filter((e) => e.quantity !== 0);

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Transfer ${t.number}`}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={words.tone}>{words.label}</Chip>
            <span>
              {t.fromLocation.code} · {t.fromLocation.name} → {t.toLocation.code} · {t.toLocation.name}
            </span>
          </span>
        }
        actions={
          <Link href="/admin/inventory/transfers" className={buttonClass}>
            All transfers
          </Link>
        }
      />
      <Message notice={notice} />
      {t.note === '' ? null : <p className="text-sm text-fg">{t.note}</p>}

      {editing && t.may.request ? (
        <section className={`${cardClass} space-y-3`} aria-label="Change the transfer">
          <TransferForm
            draft={{ id: t.id, version: t.version, from: { id: t.fromLocation.id, label: `${t.fromLocation.code} · ${t.fromLocation.name}` }, to: { id: t.toLocation.id, label: `${t.toLocation.code} · ${t.toLocation.name}` }, note: t.note, lines: t.lines.map((l) => ({ productId: l.productId, productLabel: l.productName, quantity: l.quantity })) }}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setNotice({ kind: 'ok', text: 'Saved.' });
              router.refresh();
            }}
          />
        </section>
      ) : null}

      <ul className="space-y-2" aria-label="Products on the transfer">
        {t.lines.map((l) => (
          <li key={l.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <p className="text-sm font-bold break-words text-fg-strong">{l.productName}</p>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
              <span>Asked for {l.quantity}</span>
              {t.state === 'draft' || t.state === 'requested' || t.state === 'approved' || t.state === 'cancelled' ? null : <span>Sent {l.shippedQuantity}</span>}
              {l.receivedQuantity > 0 ? <span>Received {l.receivedQuantity}</span> : null}
              {l.writtenOffQuantity > 0 ? <span>Lost {l.writtenOffQuantity}</span> : null}
              {l.returnedQuantity > 0 ? <span>Sent back {l.returnedQuantity}</span> : null}
              {l.inTransit > 0 ? <span className="font-semibold text-fg">On its way {l.inTransit}</span> : null}
            </p>
          </li>
        ))}
      </ul>

      {t.state === 'draft' && t.may.request ? (
        <section className={`${cardClass} flex flex-wrap items-center gap-2`} aria-label="Next steps">
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(requestStockTransferAction(t.id), 'Asked for. It can be sent now.')}>
            Ask for this transfer
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditing(true)}>
            Change it
          </button>
        </section>
      ) : null}

      {needsApprovalFirst && t.may.approve ? (
        <section className={`${cardClass} space-y-2`} aria-label="Approval">
          <p className="text-sm text-fg">This company wants a second person to approve a transfer before it is sent. It cannot be you if you asked for it.</p>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(approveStockTransferAction(t.id), 'Approved.')}>
            Approve
          </button>
        </section>
      ) : null}
      {needsApprovalFirst && !t.may.approve ? <p className="text-sm text-fg-muted">Waiting for someone else to approve it before it can be sent.</p> : null}

      {waitingToSend && !needsApprovalFirst && t.may.ship ? (
        <section className={`${cardClass} space-y-3`} aria-label="Send the stock">
          <h3 className="text-sm font-bold text-fg-strong">Send the stock</h3>
          <p className="text-xs text-fg-muted">The stock leaves {t.fromLocation.code} now and is on its way until it is received. Send less than was asked for if that is all you have.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {t.lines.map((l) => (
              <Field key={l.id} id={`${uid}-ship-${l.id}`} label={`Send: ${l.productName}`} hint={`Asked for ${String(l.quantity)}`}>
                <input id={`${uid}-ship-${l.id}`} inputMode="decimal" value={ship[l.id] ?? ''} onChange={(e) => setShip((q) => ({ ...q, [l.id]: e.target.value }))} className={fieldClass} autoComplete="off" />
              </Field>
            ))}
          </div>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(shipStockTransferAction(t.id, t.lines.map((l) => ({ lineId: l.id, quantity: number(ship[l.id] ?? '') }))), 'Sent. The stock is on its way.')}>
            Send the stock
          </button>
        </section>
      ) : null}

      {onItsWay && t.may.receive ? (
        <section className={`${cardClass} space-y-3`} aria-label="Record what arrived">
          <h3 className="text-sm font-bold text-fg-strong">Record what arrived</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {t.lines.filter((l) => l.inTransit > 0).map((l) => (
              <Field key={l.id} id={`${uid}-got-${l.id}`} label={`Arrived: ${l.productName}`} hint={`${String(l.inTransit)} still on its way`}>
                <input id={`${uid}-got-${l.id}`} inputMode="decimal" value={arrived[l.id] ?? ''} onChange={(e) => setArrived((q) => ({ ...q, [l.id]: e.target.value }))} className={fieldClass} autoComplete="off" />
              </Field>
            ))}
          </div>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(receiveStockTransferAction(t.id, entries(arrived)), `Recorded. The stock is now at ${t.toLocation.code}.`)}>
            Record what arrived
          </button>
        </section>
      ) : null}

      {onItsWay && t.may.ship ? (
        <section className={`${cardClass} space-y-3`} aria-label="Stock that did not arrive">
          <h3 className="text-sm font-bold text-fg-strong">Stock that did not arrive</h3>
          <p className="text-xs text-fg-muted">If some of it is not coming, say what became of it. Lost stock is written off and the books record the loss; stock sent back returns to {t.fromLocation.code}.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {t.lines.filter((l) => l.inTransit > 0).map((l) => (
              <Field key={l.id} id={`${uid}-lost-${l.id}`} label={`Not arriving: ${l.productName}`} hint={`Up to ${String(l.inTransit)}`}>
                <input id={`${uid}-lost-${l.id}`} inputMode="decimal" value={lost[l.id] ?? ''} onChange={(e) => setLost((q) => ({ ...q, [l.id]: e.target.value }))} className={fieldClass} autoComplete="off" />
              </Field>
            ))}
          </div>
          <ChoicePicker label="What became of it" source="stock-transfer-settlements" choice={settlement} onChoice={setSettlement} placeholder="Lost, or sent back" />
          <Field id={`${uid}-why`} label="Why" hint="Required.">
            <input id={`${uid}-why`} value={why} onChange={(e) => setWhy(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(resolveStockTransferAction(t.id, entries(lost).map((e) => ({ ...e, action: settlement?.id ?? '' })), why), 'Settled.')}
          >
            Settle this stock
          </button>
        </section>
      ) : null}

      {(t.state === 'draft' || waitingToSend) && t.may.request ? (
        <section className={`${cardClass} space-y-2`} aria-label="Cancel the transfer">
          <Field id={`${uid}-cancel`} label="Cancel this transfer" hint="Say why. A transfer cannot be cancelled once it is sent.">
            <input id={`${uid}-cancel`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(cancelStockTransferAction(t.id, reason), 'Cancelled.')}>
            Cancel the transfer
          </button>
        </section>
      ) : null}
      {t.state === 'cancelled' && t.cancelReason !== null ? <p className="text-sm text-fg-muted">Cancelled: {t.cancelReason}</p> : null}

      <section aria-label="History" className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">History</h3>
        <ol className="space-y-1.5">
          {t.steps.map((s) => (
            <li key={`${s.at}-${s.what}`} className="rounded-lg border border-line px-3 py-2 text-xs text-fg">
              <span className="font-semibold">{s.what}</span> by {s.by} · <time dateTime={s.at}>{when(s.at)}</time>
              {s.reason === null ? null : <span className="block text-fg-muted">{s.reason}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
