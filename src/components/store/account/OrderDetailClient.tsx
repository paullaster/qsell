'use client';

import { useBusinessTimeZone } from '@/components/business-time';
import { Suspense, use, useId, useState } from 'react';
import { Chip } from '@/components/ui/screen-kit';
import { requestVisitTimeAction, type AccountResult, type MyOrderTracking, type MyVisit } from '@/server/domains/customers/actions';
import { windowWords } from '@/lib/delivery-sla';
import {
  formatAmount,
  formatOrderDate,
  orderStateOf,
  paymentStateOf,
  type CustomerOrder,
} from '@/lib/storefront-account';
import { has } from '@/lib/values';
import { SignInPrompt } from './SignInPrompt';

/** Where the delivery stands, in words, with the page that follows it; nothing is drawn for an order with no delivery to follow. */
function DeliveryProgress({ tracking }: { tracking: Promise<AccountResult<MyOrderTracking | null>> }) {
  const timeZone = useBusinessTimeZone();
  const answer = use(tracking);
  if (!answer.ok || answer.data === null) return null;
  const t = answer.data;
  return (
    <section aria-label="Where your order is" className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-fg-strong">{t.kind === 'collection' ? 'Collecting your order' : 'Your delivery'}</h2>
      <p className="mt-1 text-sm font-medium text-fg-strong">{t.headline}</p>
      {t.detail === null ? null : <p className="text-sm text-fg-muted">{t.detail}</p>}
      {t.collection === null ? null : (
        <div className="mt-3 space-y-1 text-sm">
          <p className="font-semibold text-fg-strong">{t.collection.branchName}</p>
          {t.collection.address === '' ? null : <p className="break-words text-fg-muted">{t.collection.address}</p>}
          {t.collection.phone === null ? null : <p className="text-fg-muted">{t.collection.phone}</p>}
          {t.collection.code === null ? null : (
            <div className="pt-1">
              <p className="text-xs text-fg-muted">Show this code at the counter. It works once, so keep it to yourself.</p>
              <p aria-label={`Collection code ${t.collection.code.split('').join(' ')}`} className="mt-1 font-mono text-3xl font-bold tracking-widest text-fg-strong">
                {`${t.collection.code.slice(0, 3)}-${t.collection.code.slice(3)}`}
              </p>
            </div>
          )}
        </div>
      )}
      {t.deliveries.length === 0 ? null : (
        <ul aria-label="Deliveries of this order" className="mt-3 space-y-2 text-sm">
          {t.deliveries.map((d) => (
            <li key={d.number} className="rounded-lg border border-line bg-surface px-3 py-2">
              <p className="font-medium text-fg-strong">
                {d.number}: {d.words}
              </p>
              {d.window === null || d.words === 'Delivered' ? null : <p className="text-fg-muted">Promised: {windowWords(new Date(d.window.start), new Date(d.window.end), timeZone)}</p>}
              {d.receivedBy === null ? null : <p className="text-fg-muted">Received by {d.receivedBy}</p>}
            </li>
          ))}
        </ul>
      )}
      {t.link === null ? null : (
        <a href={t.link} className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold text-fg-strong hover:bg-hover">
          {t.kind === 'collection' ? 'See how to collect it' : 'Follow this delivery'}
        </a>
      )}
    </section>
  );
}

/** The visits booked for the order (an installation, a site job): when, where and how each stands, and a way to ask for another time. Nothing is drawn for an order with none. */
function VisitsProgress({ orderId, visits }: { orderId: string; visits: Promise<AccountResult<MyVisit[]>> }) {
  const answer = use(visits);
  const [fresh, setFresh] = useState<MyVisit[] | null>(null);
  if (!answer.ok) return null;
  const list = fresh ?? answer.data;
  if (list.length === 0) return null;
  return (
    <section aria-label="Your visit" className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-fg-strong">{list.length === 1 ? 'Your visit' : 'Your visits'}</h2>
      <ul aria-label="Visits for this order" className="mt-2 space-y-2 text-sm">
        {list.map((v) => (
          <li key={v.id} className="rounded-lg border border-line bg-surface px-3 py-2">
            <p className="font-medium text-fg-strong">{windowWords(new Date(v.startsAt), new Date(v.endsAt), v.timeZone)}</p>
            <p className="break-words text-fg-muted">{v.address}</p>
            <p className="text-fg-strong">{v.words}</p>
            {v.asked === null ? null : (
              <p role="status" className="mt-1 text-fg-muted">
                You asked for another time: “{v.asked.note}”. We will be in touch.
              </p>
            )}
            {v.canAsk ? <AskForAnotherTime orderId={orderId} visit={v} onAnswered={setFresh} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A shopper who cannot keep a visit says when would suit them better; the office answers by moving the visit. */
function AskForAnotherTime({ orderId, visit, onAnswered }: { orderId: string; visit: MyVisit; onAnswered: (visits: MyVisit[]) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 min-h-10 cursor-pointer rounded-lg border border-line px-3 text-sm font-semibold text-fg-strong hover:bg-hover">
        Ask for another time
      </button>
    );
  }
  const send = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    const r = await requestVisitTimeAction(orderId, visit.id, note).catch(() => null);
    setBusy(false);
    if (r === null) setProblem('Your request could not be sent. Please try again.');
    else if (!r.ok) setProblem(r.error);
    else onAnswered(r.data);
  };
  return (
    <form onSubmit={(e) => void send(e)} aria-label="Ask for another time" className="mt-2 space-y-2">
      <label htmlFor={`${uid}-n`} className="block text-xs font-semibold text-fg">When would suit you better?</label>
      <textarea id={`${uid}-n`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={3} required className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong" />
      <p className="text-[11px] text-fg-muted">For example “Thursday morning, or any day after the 20th”. We will get back to you; the visit stays as it is until we do.</p>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Sending…' : 'Send'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-10 cursor-pointer rounded-lg border border-line px-3 text-sm font-semibold text-fg-strong">Not now</button>
      </div>
    </form>
  );
}

export function OrderDetailClient({ result, tracking, visits }: { result: Promise<AccountResult<CustomerOrder>>; tracking?: Promise<AccountResult<MyOrderTracking | null>>; visits?: Promise<AccountResult<MyVisit[]>> }) {
  const timeZone = useBusinessTimeZone();
  const answer = use(result);
  if (!answer.ok) {
    return answer.code === 'SIGN_IN' ? (
      <SignInPrompt what="this order" />
    ) : (
      <p
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700"
      >
        {answer.error}
      </p>
    );
  }
  const order = answer.data;
  const state = orderStateOf(order.status);
  const payment = paymentStateOf(order.paymentStatus);
  const address = order.shippingAddress;
  const money = (value: number) => formatAmount(value, order.currency);
  return (
    <div className="space-y-6">
      <section
        aria-label="Order status"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-fg-strong">Order {order.orderNumber}</h2>
          <Chip tone={state.tone}>{state.label}</Chip>
          <Chip tone={payment.tone}>{payment.label}</Chip>
        </div>
        <p className="mt-1 text-sm text-fg-muted">Placed on {formatOrderDate(order.createdAt, timeZone)}</p>
        {has(state.hint) ? <p className="mt-3 text-sm text-fg">{state.hint}</p> : null}
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {order.shippedAt === null ? null : (
            <div>
              <dt className="text-fg-subtle">Shipped</dt>
              <dd className="font-medium text-fg-strong">{formatOrderDate(order.shippedAt, timeZone)}</dd>
            </div>
          )}
          {order.deliveredAt === null ? null : (
            <div>
              <dt className="text-fg-subtle">Delivered</dt>
              <dd className="font-medium text-fg-strong">{formatOrderDate(order.deliveredAt, timeZone)}</dd>
            </div>
          )}
          {order.shippingCourier === null && order.trackingNumber === null ? null : (
            <div>
              <dt className="text-fg-subtle">Courier and tracking</dt>
              <dd className="font-medium break-words text-fg-strong">
                {[order.shippingCourier, order.trackingNumber].filter(has).join(' · ')}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {tracking === undefined ? null : (
        <Suspense fallback={null}>
          <DeliveryProgress tracking={tracking} />
        </Suspense>
      )}

      {visits === undefined ? null : (
        <Suspense fallback={null}>
          <VisitsProgress orderId={order.id} visits={visits} />
        </Suspense>
      )}

      <section
        aria-label="Items"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <h2 className="text-lg font-semibold text-fg-strong">Items</h2>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((item, index) => (
            <li
              key={`${item.sku}-${String(index)}`}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="font-medium break-words text-fg-strong">{item.productName}</p>
                <p className="text-sm text-fg-muted">
                  {item.isGift ? 'Free gift · ' : ''}
                  {String(item.quantity)} × {money(item.unitPrice)}
                </p>
              </div>
              <p className="shrink-0 font-medium text-fg-strong">{money(item.totalPrice)}</p>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Subtotal</dt>
            <dd>{money(order.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Tax</dt>
            <dd>{money(order.tax)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Delivery</dt>
            <dd>{money(order.shippingFee)}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold text-fg-strong">
            <dt>Total</dt>
            <dd>{money(order.totalAmount)}</dd>
          </div>
        </dl>
      </section>

      <section
        aria-label="Delivery address"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <h2 className="text-lg font-semibold text-fg-strong">Delivered to</h2>
        <p className="mt-2 text-sm break-words text-fg">
          {[
            address.street,
            address.city,
            address.countyOrState,
            address.postalCode,
            address.country,
          ]
            .filter(has)
            .join(', ')}
        </p>
      </section>
    </div>
  );
}
