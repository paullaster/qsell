'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { acknowledgeLateAction, lateDeliveriesAction } from '@/server/domains/delivery/slot-actions';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { lateWords, windowWords } from '@/lib/delivery-sla';

type Loaded = Awaited<ReturnType<typeof lateDeliveriesAction>>;
type Data = Extract<Loaded, { ok: true }>['data'];
type Late = Data['late'][number];

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

export function LateDeliveriesClient({ firstPromise }: { firstPromise: ReturnType<typeof lateDeliveriesAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const reload = async (text: string | null) => {
    setBusy(true);
    const r = await attempt(lateDeliveriesAction());
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      if (text !== null) setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const lateCount = data.late.filter((d) => d.state === 'late').length;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Late deliveries"
        intro={`Deliveries promised a window that are at risk (the window is about to end, or it has begun and the delivery is not on its way) or late. The dispatcher is told when one is at risk or late; the supervisor, once it has been late for ${String(data.settings.escalateAfterMinutes)} minutes. Say what is being done about it to acknowledge it.`}
        actions={
          <button type="button" className={buttonClass} onClick={() => void reload(null)} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <Message notice={notice} />
      <p role="status" className="text-sm text-fg-muted">
        {data.late.length === 0 ? 'Nothing is late or at risk.' : `${String(lateCount)} late, ${String(data.late.length - lateCount)} at risk.`}
      </p>
      <ul className="space-y-3" aria-label="Late delivery list">
        {data.late.map((d) => (
          <LateCard key={d.deliveryId} item={d} onDone={(t) => void reload(t)} onError={(t) => setNotice({ kind: 'error', text: t })} />
        ))}
      </ul>
    </div>
  );
}

function LateCard({ item, onDone, onError }: { item: Late; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ack = async () => {
    setBusy(true);
    const r = await attempt(acknowledgeLateAction({ deliveryId: item.deliveryId, note }));
    setBusy(false);
    if (r.ok) onDone('Acknowledged.');
    else onError(r.error);
  };
  return (
    <li className={`${cardClass} space-y-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg-strong">
            <Link href={`/admin/delivery/deliveries/${item.deliveryId}`} className="underline">
              {item.number}
            </Link>{' '}
            · Order {item.orderNumber} · {item.customerName}
          </p>
          <p className="text-sm text-fg">
            Promised {windowWords(new Date(item.windowStart), new Date(item.windowEnd))} · {item.branchName}
          </p>
        </div>
        <Chip tone={item.state === 'late' ? 'red' : 'amber'}>{item.state === 'late' ? `Late by ${lateWords(item.minutesLate)}` : item.stateWords}</Chip>
      </div>
      <p className="text-xs text-fg-muted">
        {item.levelWords ?? 'Not raised yet; the worker raises it within a minute.'}
        {item.raisedAt === null ? '' : ` · raised ${when(item.raisedAt)}`}
      </p>
      {item.acknowledged === null ? (
        <form
          aria-label={`Acknowledge ${item.number}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ack();
          }}
        >
          <Field id={`${uid}-n`} label="What is being done about it">
            <input id={`${uid}-n`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" required />
          </Field>
          <button type="submit" className={primaryClass} disabled={busy}>
            Acknowledge
          </button>
        </form>
      ) : (
        <p className="text-sm text-fg">
          Acknowledged {when(item.acknowledged.at)}
          {item.acknowledged.note === null ? '' : `: ${item.acknowledged.note}`}
        </p>
      )}
    </li>
  );
}
