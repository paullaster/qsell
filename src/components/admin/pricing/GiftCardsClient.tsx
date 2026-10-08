'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listPricingReasonsAction } from '@/server/domains/pricing/actions';
import {
  blockGiftCardAction,
  issueGiftCardsAction,
  listGiftCardsAction,
  lookupGiftCardAction,
} from '@/server/domains/pricing/retrospective-actions';
import type { GiftCardDetail, GiftCardView } from '@/server/domains/pricing/giftcard-service';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  When,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { CustomerLookup, type PickedCustomer } from './CustomerLookup';
import { money } from './DiscountsClient';

const KIND: Record<string, string> = {
  issue: 'Issued',
  redeem: 'Spent on an order',
  reverse: 'Given back (order cancelled)',
  adjust: 'Adjusted',
};

function cardChip(c: GiftCardView) {
  if (c.status === 'blocked') return <Chip tone="red">Blocked</Chip>;
  if (!c.usable)
    return <Chip tone="grey">{c.unusableReason?.includes('expired') ? 'Expired' : 'Used up'}</Chip>;
  return <Chip tone="green">Usable</Chip>;
}

export function GiftCardsClient({
  initial,
  canManage,
}: {
  initial: GiftCardView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [cards, setCards] = useState(initial);
  const [search, setSearch] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [open, setOpen] = useState<GiftCardDetail | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [made, setMade] = useState<GiftCardView[] | null>(null);

  // Issue form
  const [value, setValue] = useState('');
  const [count, setCount] = useState('1');
  const [expires, setExpires] = useState('');
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void listGiftCardsAction(search || undefined).then((r) => {
        if (live && r.ok) setCards(r.data);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [search]);

  const refresh = async () => {
    const r = await listGiftCardsAction(search || undefined);
    if (r.ok) setCards(r.data);
  };

  const issue = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await issueGiftCardsAction(
      {
        value: Number(value),
        count: Math.trunc(Number(count)) || 1,
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        customerId: customer?.id ?? null,
        note: note || null,
      },
      reason,
    );
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    setMade(r.data);
    setIssuing(false);
    setValue('');
    setCount('1');
    setExpires('');
    setCustomer(null);
    setNote('');
    setReason({ code: '', text: '' });
    await refresh();
    router.refresh();
  };

  const view = async (code: string) => {
    setMessage(null);
    const r = await lookupGiftCardAction(code);
    if (r.ok) setOpen(r.data);
    else setMessage({ kind: 'error', text: r.error });
  };

  const toggle = async (c: GiftCardDetail) => {
    setBusy(true);
    const r = await blockGiftCardAction(c.id, c.status !== 'blocked', reason);
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    setReason({ code: '', text: '' });
    await view(c.code);
    await refresh();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ kind: 'ok', text: 'Copied.' });
    } catch {
      setMessage({
        kind: 'error',
        text: 'Could not copy. Select the codes and copy them by hand.',
      });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gift cards"
        actions={
          canManage && !issuing ? (
            <button type="button" className={primaryButtonClass} onClick={() => setIssuing(true)}>
              Issue gift cards
            </button>
          ) : null
        }
      >
        Prepaid value with a code. A card pays for an order, in part or in full, from the
        order&apos;s payment panel. It is a payment, not a price change, so tax and invoices are
        unaffected. A card can never go below zero, even with many orders using it at once.
      </PageHeader>
      <Notice message={message} />

      {made ? (
        <section aria-label="Issued cards" role="status" className={`${cardClass} space-y-2`}>
          <p className="text-sm font-semibold text-fg-strong">
            {made.length} card{made.length === 1 ? '' : 's'} issued. Keep these codes safe: anyone
            with a code can spend the card.
          </p>
          <ul className="grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">
            {made.map((c) => (
              <li key={c.id}>
                {c.code} <span className="text-fg-muted">{money(c.initialValue)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => void copy(made.map((c) => c.code).join('\n'))}
            >
              Copy the codes
            </button>
            <button type="button" className={buttonClass} onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </section>
      ) : null}

      {issuing ? (
        <form onSubmit={issue} className={`${cardClass} space-y-4`} aria-label="Issue gift cards">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={`${uid}-v`} className={labelClass}>
                Value of each card
              </label>
              <input
                id={`${uid}-v`}
                type="number"
                min={1}
                step="0.01"
                className={fieldClass}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor={`${uid}-n`} className={labelClass}>
                How many cards
              </label>
              <input
                id={`${uid}-n`}
                type="number"
                min={1}
                max={500}
                className={fieldClass}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor={`${uid}-e`} className={labelClass}>
                Expires on (optional)
              </label>
              <input
                id={`${uid}-e`}
                type="date"
                className={fieldClass}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>
          </div>
          <CustomerLookup value={customer} onChange={setCustomer} label="Issued to (optional)" />
          <div>
            <label htmlFor={`${uid}-note`} className={labelClass}>
              Note (optional, for example the campaign)
            </label>
            <input
              id={`${uid}-note`}
              className={`${fieldClass} sm:max-w-md`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || !reason.code || !value}
            >
              {busy ? 'Issuing…' : 'Issue'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setIssuing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div>
        <label htmlFor={`${uid}-s`} className={labelClass}>
          Find a card (code, note or customer)
        </label>
        <input
          id={`${uid}-s`}
          className={`${fieldClass} sm:max-w-md`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {cards.length === 0 ? (
        <EmptyState title="No gift cards found">
          Issue some, or check the code. Codes ignore spaces, dashes and capitals.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => (
            <li key={c.id} className={`${cardClass} !p-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-sm font-semibold text-fg-strong">{c.code}</span>{' '}
                  {cardChip(c)}
                  <p className="text-xs text-fg-muted">
                    {money(c.balance)} left of {money(c.initialValue)}
                    {c.expiresAt
                      ? ` · expires ${new Date(c.expiresAt).toLocaleDateString('en-KE')}`
                      : ''}
                    {c.customerName ? ` · ${c.customerName}` : ''}
                    {c.note ? ` · ${c.note}` : ''}
                  </p>
                </div>
                <button type="button" className={buttonClass} onClick={() => void view(c.code)}>
                  Open
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <section aria-label="Card detail" className={`${cardClass} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-sm font-bold text-fg-strong">{open.code}</h2>
            <button type="button" className={buttonClass} onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <p className="text-sm text-fg">
            {money(open.balance)} left of {money(open.initialValue)}.{' '}
            {open.unusableReason ?? 'It can be used.'}
          </p>
          {canManage ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !reason.code}
                onClick={() => void toggle(open)}
              >
                {open.status === 'blocked' ? 'Unblock this card' : 'Block this card'}
              </button>
            </div>
          ) : null}
          <table className="w-full text-sm">
            <caption className="sr-only">Card history</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="py-2 pr-3 font-semibold">What happened</th>
                <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                <th className="py-2 font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {open.ledger.map((l) => (
                <tr key={l.id} className="border-b border-line/60">
                  <td className="py-2 pr-3">{KIND[l.kind] ?? l.kind}</td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {l.amount > 0 ? `+${money(l.amount)}` : money(l.amount)}
                  </td>
                  <td className="py-2 text-xs text-fg-muted">
                    <When iso={l.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
