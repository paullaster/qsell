'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  activatePriceListAction,
  listPricingReasonsAction,
  retirePriceListAction,
  updatePriceListAction,
  type PriceListDetail,
  type PricingLookups,
} from '@/server/domains/pricing/actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  dangerButtonClass,
  primaryButtonClass,
  When,
  type Message,
} from '../approvals/shared';
import { PriceLinesPanel } from './PriceLinesPanel';
import { PriceListForm } from './PriceListForm';
import { listStatusChip } from './PriceListsClient';

const ACTIONS: Record<string, string> = {
  'pricing.list_created': 'Created as a draft',
  'pricing.list_changed': 'Settings changed',
  'pricing.activation_requested': 'Sent for approval',
  'pricing.list_activated': 'Put in force',
  'pricing.list_retired': 'Retired',
  'pricing.prices_changed': 'Prices set',
  'pricing.prices_removed': 'Prices removed',
};

export function PriceListDetailClient({
  detail,
  lookups,
  canManage,
}: {
  detail: PriceListDetail;
  lookups: PricingLookups;
  canManage: boolean;
}) {
  const router = useRouter();
  const { list, issues, timeline, names } = detail;
  const [editing, setEditing] = useState(false);
  const [lifecycle, setLifecycle] = useState<'activate' | 'retire' | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const waiting = list.approvalStatus === 'pending';
  const retired = list.status === 'retired';
  const editable = canManage && !retired && !waiting;

  const confirm = async () => {
    if (!lifecycle) return;
    setBusy(true);
    setMessage(null);
    const r =
      lifecycle === 'activate'
        ? await activatePriceListAction(list.id, reason)
        : await retirePriceListAction(list.id, reason);
    setBusy(false);
    if (r.ok) {
      setLifecycle(null);
      setReason({ code: '', text: '' });
      const heldMessage = r.data.pending ? (r.data.message ?? 'Sent for approval.') : null;
      setMessage({
        kind: 'ok',
        text:
          heldMessage ??
          (lifecycle === 'activate' ? 'The price list is in force.' : 'The price list is retired.'),
      });
      router.refresh();
    } else {
      setMessage({ kind: 'error', text: r.error });
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/pricing"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← All price lists
        </Link>
      </p>
      <PageHeader
        title={list.name}
        actions={
          editable ? (
            <>
              {list.status === 'draft' ? (
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => setLifecycle('activate')}
                >
                  Put in force
                </button>
              ) : null}
              <button type="button" className={buttonClass} onClick={() => setEditing((e) => !e)}>
                {editing ? 'Close settings' : 'Change settings'}
              </button>
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => setLifecycle('retire')}
              >
                Retire
              </button>
            </>
          ) : null
        }
      >
        {list.code} · {list.currency}
        {list.kind === 'contract' ? ' · contract price' : ''}
      </PageHeader>

      <section className={`${cardClass} space-y-2`} aria-label="Summary">
        <div className="flex flex-wrap items-center gap-2">
          {listStatusChip(list)}
          <span className="text-xs text-fg-muted">
            Version {list.version} · changed <When iso={list.updatedAt} />
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Fact label="Applies to" value={list.scopeText} />
          <Fact label="Prices" value={list.taxInclusive ? 'Include tax' : 'Exclude tax'} />
          <Fact
            label="Quantity breaks"
            value={list.quantityMode === 'all_units' ? 'On every unit' : 'Step by step'}
          />
          <Fact label="Priority" value={String(list.priority)} />
          <Fact label="In force from" value={new Date(list.validFrom).toLocaleString('en-KE')} />
          <Fact
            label="Until"
            value={list.validTo ? new Date(list.validTo).toLocaleString('en-KE') : 'No end'}
          />
        </dl>
        {waiting ? (
          <p role="status" className="text-sm text-amber-700">
            Waiting for approval before it can go live. Settings and prices are locked until it is
            decided. You can withdraw the request under{' '}
            <Link href="/admin/approvals" className="underline">
              Approvals
            </Link>
            .
          </p>
        ) : null}
        {list.status === 'draft' && list.approvalStatus === 'rejected' ? (
          <p role="status" className="text-sm text-red-700">
            The approvers refused this list. Change it and put it in force again to ask once more.
          </p>
        ) : null}
        {list.status === 'draft' && issues.length > 0 ? (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800"
          >
            <p className="font-semibold">Before this can go live:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {lifecycle ? (
        <section aria-label="Confirm" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            {lifecycle === 'activate'
              ? 'Put this price list in force? Sales it applies to will be priced from it straight away, unless an approval is required first.'
              : 'Retire this price list? It stops pricing sales at once and cannot be put back in force; its history stays.'}
          </p>
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={lifecycle === 'retire' ? dangerButtonClass : primaryButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void confirm()}
            >
              {busy ? 'Working…' : lifecycle === 'activate' ? 'Put in force' : 'Retire'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setLifecycle(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <Notice message={message} />

      {editing && editable ? (
        <section aria-label="Change settings" className={cardClass}>
          <h3 className="mb-3 text-sm font-bold text-fg-strong">Change settings</h3>
          {list.status === 'active' ? (
            <p className="mb-3 text-xs text-amber-700">
              This list is in force, so a change to who it applies to, its priority, dates or tax
              basis affects live prices. It may need approval first, and changes that would make it
              tie with another list are refused.
            </p>
          ) : null}
          <PriceListForm
            mode="edit"
            initial={list}
            lookups={lookups}
            names={names}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (values, why) => {
              const r = await updatePriceListAction(
                list.id,
                {
                  name: values.name,
                  description: values.description,
                  taxInclusive: values.taxInclusive,
                  quantityMode: values.quantityMode,
                  priority: values.priority,
                  validFrom: values.validFrom,
                  validTo: values.validTo,
                  scopes: values.scopes,
                },
                why,
              );
              if (r.ok) {
                setEditing(false);
                setMessage({
                  kind: 'ok',
                  text: r.data.pending ? r.data.message : `Saved as version ${r.data.version}.`,
                });
                router.refresh();
                return { ok: true };
              }
              return { ok: false, error: r.error, issues: r.issues };
            }}
          />
        </section>
      ) : null}

      <PriceLinesPanel
        listId={list.id}
        editable={editable}
        live={list.status === 'active'}
        quantityMode={list.quantityMode}
        onChanged={() => router.refresh()}
      />

      <section aria-labelledby="history" className={cardClass}>
        <h3 id="history" className="mb-2 text-sm font-bold text-fg-strong">
          What happened to this list
        </h3>
        <ol className="space-y-2 text-sm">
          {[...timeline].reverse().map((e, i) => (
            <li key={i} className="border-l-2 border-line pl-3">
              <p className="font-semibold text-fg-strong">
                {ACTIONS[e.action] ?? e.action.replace(/^pricing\./, '').replace(/_/g, ' ')}
                {e.detail ? <span className="font-normal text-fg-muted"> · {e.detail}</span> : null}
              </p>
              <p className="text-xs text-fg-muted">
                <When iso={e.at} />
                {e.reason ? ` · ${e.reason}` : ''}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-2">
      <dt className="text-xs font-semibold text-fg-muted sm:w-32 sm:shrink-0 sm:pt-0.5">{label}</dt>
      <dd className="text-fg-strong">{value}</dd>
    </div>
  );
}
