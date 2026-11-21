'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Trash2, Wifi, WifiOff } from 'lucide-react';
import { syncOfflineSaleAction } from '@/server/domains/selling/offline/offline-actions';
import type { OfflineSnapshot } from '@/server/domains/selling/offline/offline-sale-service';
import { linesTotalCents, type OfflineSale } from '@/server/domains/selling/offline/offline-rules';
import { planTenders, type TenderKind } from '@/server/domains/selling/cash-sales/tender-rules';
import { Autocomplete } from '@/components/ui/autocomplete/Autocomplete';
import { Chip, Field, PageHeader, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { afterSend, deviceRefOf, mayStillSell, pendingTotal, type OutboxEntry } from '@/lib/offline-till/outbox';
import { signInBrowser } from '@/lib/offline-till/sign';
import { deviceId, getMeta, nextCounter, outboxAll, outboxDelete, outboxPut } from '@/lib/offline-till/store';
import { prepareOfflineTill } from '@/lib/offline-till/ready';
import { PrintButton } from '@/components/ui/PrintButton';

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const KIND_WORDS: Record<string, string> = { cash: 'Cash', card: 'Card', mobile_money: 'M-Pesa or mobile money' };
let counter = 0;
const nextKey = (): string => `row-${String((counter += 1))}`;

interface Line {
  key: string;
  productId: string;
  name: string;
  price: number;
  quantity: string;
  decimals: number;
}
interface TenderRow {
  key: string;
  methodId: string;
  amount: string;
  reference: string;
}

/**
 * The counter with no connection. It sells from what the browser kept while online (what may be sold, at what price, how it may be
 * paid, and the shift's key), signs each sale, gives the customer a slip with the till's own reference, and sends every sale when the
 * connection returns. It never prices by rule and never decides anything the server must: it only rings up and remembers.
 */
export function OfflineTillClient() {
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [tenders, setTenders] = useState<TenderRow[]>([{ key: nextKey(), methodId: '', amount: '', reference: '' }]);
  const [problem, setProblem] = useState<string | null>(null);
  const [slip, setSlip] = useState<OutboxEntry | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  const sending = useRef(false);

  const reloadOutbox = useCallback(async () => {
    try {
      setEntries(await outboxAll());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The till\'s memory could not be read.');
    }
  }, []);

  useEffect(() => {
    const mounted = { live: true };
    void (async () => {
      try {
        const kept = await getMeta<OfflineSnapshot>('snapshot');
        if (mounted.live) setSnapshot(kept ?? null);
        await reloadOutbox();
      } catch (error) {
        if (mounted.live) setProblem(error instanceof Error ? error.message : 'The till\'s memory could not be read.');
      }
      if (mounted.live) setReady(true);
    })();
    return () => {
      mounted.live = false;
    };
  }, [reloadOutbox]);

  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      const waiting = (await outboxAll()).filter((e) => e.state === 'pending');
      for (const entry of waiting) {
        let answer: Parameters<typeof afterSend>[1];
        try {
          answer = await syncOfflineSaleAction(entry.sale);
        } catch {
          answer = { thrown: true };
        }
        const next = afterSend(entry, answer);
        if (next.kind === 'keep') {
          await outboxPut(next.entry);
          if ('thrown' in answer) break;
        } else {
          await outboxDelete(entry.key);
          setMessages((m) => [next.words, ...m].slice(0, 20));
        }
      }
    } finally {
      sending.current = false;
      await reloadOutbox();
    }
  }, [reloadOutbox]);

  // Whether there is a connection: the browser's own word, checked by asking the server (the browser can say "online" while nothing gets through, and a worker can answer pages with no connection at all).
  useEffect(() => {
    const state = { live: true };
    const probe = async () => {
      if (!navigator.onLine) {
        if (state.live) setOnline(false);
        return;
      }
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 4000);
      try {
        await fetch('/api/health', { cache: 'no-store', signal: stop.signal });
        if (state.live) setOnline(true);
      } catch {
        if (state.live) setOnline(false);
      } finally {
        clearTimeout(timer);
      }
    };
    const onOffline = () => setOnline(false);
    const onOnline = () => void probe();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    void probe();
    const every = setInterval(() => void probe(), 5000);
    return () => {
      state.live = false;
      clearInterval(every);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  // Whenever there is a connection: send what is waiting, and keep the till ready (a fresh key and price list).
  useEffect(() => {
    if (!online || !ready) return;
    void send();
    void prepareOfflineTill().then(async (r) => {
      if (r.ok) setSnapshot((await getMeta<OfflineSnapshot>('snapshot')) ?? null);
    });
    const timer = setInterval(() => void send(), 30_000);
    return () => clearInterval(timer);
  }, [online, ready, send]);

  const priced = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: l.price }));
  const valid = priced.length > 0 && priced.every((l) => l.quantity > 0 && Number.isFinite(l.quantity));
  const total = valid ? linesTotalCents(priced) / 100 : 0;
  const requests = snapshot === null ? [] : tenders.flatMap((t) => {
    const method = snapshot.methods.find((m) => m.id === t.methodId);
    return method === undefined || t.amount.trim() === '' ? [] : [{ methodId: method.id, kind: method.kind as TenderKind, amount: Number(t.amount), reference: t.reference.trim() === '' ? null : t.reference.trim() }];
  });
  const plan = valid && total > 0 && requests.length > 0 ? planTenders(total, requests) : null;
  const needsReference = snapshot !== null && tenders.some((t) => snapshot.methods.find((m) => m.id === t.methodId)?.requiresReference === true && t.reference.trim() === '');

  const complete = async () => {
    if (snapshot === null || plan?.ok !== true) return;
    const room = mayStillSell({ limits: snapshot.limits, soldSoFar: snapshot.soldSoFar, entries, total });
    if (!room.ok) {
      setProblem(room.error);
      return;
    }
    setProblem(null);
    try {
      const id = await deviceId();
      const draft: OfflineSale = { key: crypto.randomUUID(), shiftId: snapshot.shiftId, deviceRef: deviceRefOf(id, await nextCounter()), deviceTime: new Date().toISOString(), lines: priced, tenders: tenders.flatMap((t) => (t.methodId === '' ? [] : [{ methodId: t.methodId, amount: Number(t.amount), reference: t.reference.trim() }])), total };
      const sale = await signInBrowser(snapshot.secret, draft);
      const entry: OutboxEntry = { key: sale.key, sale, state: 'pending', reason: null, tries: 0, words: { lines: lines.map((l) => ({ name: l.name, quantity: Number(l.quantity), unitPrice: l.price })), change: plan.changeDue } };
      await outboxPut(entry);
      setSlip(entry);
      setLines([]);
      setTenders([{ key: nextKey(), methodId: '', amount: '', reference: '' }]);
      await reloadOutbox();
      if (navigator.onLine) void send();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The sale could not be kept on the till. Do not give the goods: try again.');
    }
  };

  const loadProducts = ({ query }: { query: string; cursor: string | null; limit: number }) => {
    const needle = query.trim().toLowerCase();
    const found = (snapshot?.products ?? []).filter((p) => needle === '' || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)).slice(0, 20);
    return Promise.resolve({ options: found.map((p) => ({ id: p.id, label: p.name, description: `${p.sku} · ${money(p.price)}`, badge: null })), nextCursor: null });
  };

  const waiting = entries.filter((e) => e.state === 'pending');
  const attention = entries.filter((e) => e.state === 'attention');
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <PageHeader title="Offline till" intro="Sells from what this browser kept while it was online. Each sale is kept on this till and sent when the connection returns; the customer's real receipt follows then." actions={<Link href="/admin/cash-sales" className={buttonClass}>Back to Cash Sales</Link>} />
      <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 print:hidden`} data-testid="till-status">
        <div className="flex items-center gap-2">
          {online ? <Wifi className="size-5 text-emerald-600" aria-hidden /> : <WifiOff className="size-5 text-amber-600" aria-hidden />}
          <p className="font-semibold text-fg-strong" data-testid="till-connection">{online ? 'Connected' : 'No connection: selling from what the till kept'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={waiting.length === 0 ? 'green' : 'amber'}>{waiting.length === 0 ? 'Nothing waiting to be sent' : `${String(waiting.length)} sale(s) waiting to be sent (${money(pendingTotal(entries))})`}</Chip>
          {attention.length === 0 ? null : <Chip tone="red">{`${String(attention.length)} need attention`}</Chip>}
        </div>
      </div>
      {messages.length === 0 ? null : <ul className="space-y-1 text-sm text-fg-muted" aria-label="Sent" data-testid="till-sent">{messages.map((m) => <li key={m}>{m}</li>)}</ul>}
      {attention.length === 0 ? null : (
        <ul className="space-y-1 text-sm text-red-700" aria-label="Needs attention" data-testid="till-attention">
          {attention.map((e) => <li key={e.key}>{e.sale.deviceRef} ({money(e.sale.total)}): {e.reason ?? 'could not be sent'}</li>)}
        </ul>
      )}
      {!ready ? <p role="status" className="text-sm text-fg-muted">Opening the till…</p> : null}
      {ready && snapshot === null ? (
        <div className={`${cardClass} space-y-2`} data-testid="till-not-ready">
          <p className="font-semibold text-fg-strong">This till is not ready for offline selling.</p>
          <p className="text-sm text-fg-muted">Open Cash Sales while online with a shift open (and offline selling switched on). The till then keeps what it needs, and this page opens with no connection.</p>
        </div>
      ) : null}
      {slip === null ? null : <Slip entry={slip} onClose={() => setSlip(null)} />}
      {snapshot === null ? null : (
        <section className="grid gap-4 lg:grid-cols-[1fr_20rem] print:hidden" aria-label="New sale">
          <div className="space-y-4">
            <div className={`${cardClass} space-y-3`}>
              <h2 className="text-base font-bold text-fg-strong">What is being bought</h2>
              <Autocomplete key={pickerKey} label="Add a product" value={null} onChange={(o) => { if (o === null) return; const p = snapshot.products.find((x) => x.id === o.id); if (p === undefined) return; setLines((c) => [...c, { key: nextKey(), productId: p.id, name: p.name, price: p.price, quantity: '1', decimals: p.decimals }]); setPickerKey((n) => n + 1); }} loadOptions={loadProducts} placeholder="Search a product or its code…" />
              {lines.length === 0 ? <p className="text-sm text-fg-muted" data-testid="sale-empty">Nothing added yet.</p> : (
                <ul className="space-y-2" data-testid="sale-lines">
                  {lines.map((l) => (
                    <li key={l.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-2" data-testid="sale-line">
                      <span className="min-w-0 flex-1 font-medium break-words text-fg-strong">{l.name}<span className="block text-xs text-fg-muted">{money(l.price)} each</span></span>
                      <input aria-label={`Quantity of ${l.name}`} type="number" inputMode="decimal" min={0} step={l.decimals === 0 ? 1 : 'any'} className={`${fieldClass} w-24`} value={l.quantity} onChange={(e) => setLines((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} />
                      <button type="button" className={buttonClass} aria-label={`Remove ${l.name}`} onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}><Trash2 className="size-4" aria-hidden /></button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-fg-muted">Prices are the list prices the till kept. Discounts, price lists and customers need the connection.</p>
            </div>
            <div className={`${cardClass} space-y-3`}>
              <h2 className="text-base font-bold text-fg-strong">Payment</h2>
              <ul className="space-y-3" data-testid="tenders">
                {tenders.map((t, n) => {
                  const method = snapshot.methods.find((m) => m.id === t.methodId);
                  return (
                    <li key={t.key} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]" data-testid="tender">
                      <Autocomplete label={n === 0 ? 'Paid with' : `And with (${String(n + 1)})`} value={method?.id ?? null} valueLabel={method?.name ?? null} onChange={(o) => setTenders((c) => c.map((x) => (x.key === t.key ? { ...x, methodId: o?.id ?? '' } : x)))} loadOptions={() => Promise.resolve({ options: snapshot.methods.map((m) => ({ id: m.id, label: m.name, description: KIND_WORDS[m.kind] ?? null, badge: null })), nextCursor: null })} placeholder="Cash, M-Pesa or card…" />
                      <Field id={`amount-${t.key}`} label={method?.kind === 'cash' ? 'Handed over (KES)' : 'Amount (KES)'}><input id={`amount-${t.key}`} type="number" inputMode="decimal" min={0} step="0.01" className={fieldClass} value={t.amount} onChange={(e) => setTenders((c) => c.map((x) => (x.key === t.key ? { ...x, amount: e.target.value } : x)))} /></Field>
                      {tenders.length > 1 ? <button type="button" className={`${buttonClass} self-end`} aria-label="Remove this way of paying" onClick={() => setTenders((c) => c.filter((x) => x.key !== t.key))}><Trash2 className="size-4" aria-hidden /></button> : null}
                      {method?.requiresReference === true ? <div className="sm:col-span-3"><Field id={`ref-${t.key}`} label={method.kind === 'card' ? 'Card slip number' : 'M-Pesa code'}><input id={`ref-${t.key}`} className={fieldClass} value={t.reference} maxLength={60} onChange={(e) => setTenders((c) => c.map((x) => (x.key === t.key ? { ...x, reference: e.target.value } : x)))} /></Field></div> : null}
                    </li>
                  );
                })}
              </ul>
              {tenders.length < 4 ? <button type="button" className={buttonClass} onClick={() => setTenders((c) => [...c, { key: nextKey(), methodId: '', amount: '', reference: '' }])}>Add another way of paying</button> : null}
            </div>
          </div>
          <aside className={`${cardClass} h-fit space-y-3 lg:sticky lg:top-4`} aria-label="Sale total" aria-live="polite">
            <h2 className="text-base font-bold text-fg-strong">Total</h2>
            <p className="text-3xl font-bold text-fg-strong" data-testid="sale-total">{total > 0 ? money(total) : '—'}</p>
            <PlanLine plan={plan} />
            {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="sale-problem">{problem}</p>}
            <button type="button" className={`${primaryClass} w-full`} disabled={plan?.ok !== true || needsReference} onClick={() => void complete()}>Complete sale</button>
          </aside>
        </section>
      )}
    </div>
  );
}

function PlanLine({ plan }: { plan: ReturnType<typeof planTenders> | null }) {
  if (plan === null) return null;
  if (!plan.ok) return <p role="alert" className="text-sm text-amber-700" data-testid="sale-plan-problem">{plan.error}</p>;
  return <p className="text-lg font-semibold text-emerald-700" data-testid="sale-change">Change to give: {money(plan.changeDue)}</p>;
}

function Slip({ entry, onClose }: { entry: OutboxEntry; onClose: () => void }) {
  return (
    <section id="offline-slip" className={`${cardClass} space-y-2 text-sm`} aria-label="Slip" data-testid="till-slip">
      <h2 className="text-base font-bold text-fg-strong">Slip {entry.sale.deviceRef}</h2>
      <p className="text-fg-muted">Kept on this till. The tax receipt follows when the connection returns: keep this slip until then.</p>
      <ul className="space-y-0.5">{entry.words.lines.map((l) => <li key={l.name} className="flex justify-between gap-3"><span>{l.quantity} × {l.name}</span><span className="font-mono">{money(l.quantity * l.unitPrice)}</span></li>)}</ul>
      <p className="flex justify-between gap-3 font-semibold text-fg-strong"><span>Total</span><span className="font-mono">{money(entry.sale.total)}</span></p>
      <p className="flex justify-between gap-3 text-lg font-bold text-fg-strong"><span>Change given</span><span className="font-mono" data-testid="slip-change">{money(entry.words.change)}</span></p>
      <div className="flex gap-2 print:hidden">
        <PrintButton targetId="offline-slip" title={`Slip ${entry.sale.deviceRef}`} paper="slip" label="Print slip" testId="slip-print" />
        <button type="button" className={primaryClass} onClick={onClose}>New sale</button>
      </div>
    </section>
  );
}
