'use client';

import Link from 'next/link';
import { useState } from 'react';
import { resubmitOrderApprovalAction } from '@/server/domains/orders/actions';
import type { Order } from '@/types/index';
import { Chip, buttonClass, primaryButtonClass } from './shared';

import { has } from '@/lib/values';

/** Says where an order stands with approvals, and what can be done about it. */
export function OrderApprovalBanner({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = order.approvalStatus ?? 'none';
  if (status === 'none') return null;
  if (status === 'approved') return <Chip tone="green">Approved</Chip>;

  const resend = async () => {
    setBusy(true);
    setError(null);
    const res = await resubmitOrderApprovalAction(order.id);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onChanged();
  };

  const tone =
    status === 'pending'
      ? 'border-amber-500/40 bg-amber-500/10'
      : 'border-red-500/40 bg-red-500/10';
  return (
    <div
      role="status"
      className={`space-y-2 rounded-lg border p-3.5 text-sm text-fg-strong ${tone}`}
    >
      {status === 'pending' ? (
        <p>
          <strong>Waiting for approval.</strong> This order cannot be shipped or invoiced until it
          is approved. You can still cancel it.
        </p>
      ) : null}
      {status === 'rejected' ? (
        <p>
          <strong>Approval was refused.</strong> The person who sent it can reopen it from{' '}
          <Link href="/admin/approvals/requests" className="underline">
            My requests
          </Link>
          , or you can cancel the order.
        </p>
      ) : null}
      {status === 'draft' ? (
        <p>
          <strong>Reopened.</strong> Send it for approval again once the reason it was refused has
          been dealt with, or cancel the order.
        </p>
      ) : null}
      {status === 'draft' ? (
        <button type="button" className={primaryButtonClass} disabled={busy} onClick={resend}>
          {busy ? 'Sending…' : 'Send for approval again'}
        </button>
      ) : null}
      {status === 'pending' ? (
        <Link href="/admin/settings/approvals/monitor" className={`${buttonClass} no-underline`}>
          See who it is waiting on
        </Link>
      ) : null}
      {has(error) ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
