'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  activateDiscountRuleAction,
  createCouponsAction,
  pauseDiscountRuleAction,
  retireDiscountRuleAction,
  setCouponStatusAction,
  type DiscountDetail,
  type DiscountLookups,
} from '@/server/domains/pricing/discount-actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  Notice,
  PageHeader,
  When,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { DiscountForm } from './DiscountForm';
import { DiscountSimulator } from './DiscountSimulator';
import { RuleImpactPanel } from './RuleImpactPanel';
import { discountChip, money } from './DiscountsClient';
import { fromLocalInput } from './PriceListForm';

const EVENTS: Record<string, string> = {
  'pricing.discount_created': 'Created as a draft',
  'pricing.discount_changed': 'Changed',
  'pricing.discount_activation_requested': 'Sent for approval',
  'pricing.discount_activated': 'Put in force',
  'pricing.discount_paused': 'Paused',
  'pricing.discount_retired': 'Retired',
  'pricing.coupons_created': 'Coupons added',
  'pricing.coupon_changed': 'Coupon changed',
};

export function DiscountDetailClient({
  detail,
  lookups,
  productNames,
  canManage,
}: {
  detail: DiscountDetail;
  lookups: DiscountLookups;
  productNames: Record<string, string>;
  canManage: boolean;
}) {
  const router = useRouter();
  const { rule } = detail;
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<'activate' | 'pause' | 'retire' | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const waiting = rule.approvalStatus === 'pending';
  const retired = rule.status === 'retired';
  const canEdit = canManage && !waiting && (rule.status === 'draft' || rule.status === 'paused');

  const confirm = async () => {
    if (!action) return;
    setBusy(true);
    setMessage(null);
    if (action === 'activate') {
      const r = await activateDiscountRuleAction(rule.id, reason);
      setBusy(false);
      if (!r.ok) return setMessage({ kind: 'error', text: r.error });
      setMessage({
        kind: 'ok',
        text: r.data.pending ? (r.data.message ?? 'Sent for approval.') : 'The rule is in force.',
      });
    } else {
      const r =
        action === 'pause'
          ? await pauseDiscountRuleAction(rule.id, reason)
          : await retireDiscountRuleAction(rule.id, reason);
      setBusy(false);
      if (!r.ok) return setMessage({ kind: 'error', text: r.error });
      setMessage({
        kind: 'ok',
        text: action === 'pause' ? 'The rule is paused.' : 'The rule is retired.',
      });
    }
    setAction(null);
    setReason({ code: '', text: '' });
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/pricing/discounts"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← All discounts
        </Link>
      </p>
      <PageHeader
        title={rule.name}
        actions={
          canManage && !retired && !waiting ? (
            <>
              {rule.status !== 'active' ? (
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => setAction('activate')}
                >
                  Put in force
                </button>
              ) : null}
              {canEdit ? (
                <button type="button" className={buttonClass} onClick={() => setEditing((e) => !e)}>
                  {editing ? 'Close editor' : 'Change'}
                </button>
              ) : null}
              {rule.status === 'active' ? (
                <button type="button" className={buttonClass} onClick={() => setAction('pause')}>
                  Pause
                </button>
              ) : null}
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => setAction('retire')}
              >
                Retire
              </button>
            </>
          ) : null
        }
      >
        {rule.code} · {rule.kind === 'line' ? 'line discount' : 'order discount'} · version{' '}
        {rule.version}
      </PageHeader>

      <section aria-label="Summary" className={`${cardClass} space-y-2`}>
        <div className="flex flex-wrap items-center gap-2">
          {discountChip(rule)}
          <span className="text-xs text-fg-muted">
            Changed <When iso={rule.updatedAt} />
          </span>
        </div>
        <p className="text-sm text-fg-strong">{rule.summary}</p>
        <p className="text-xs text-fg-muted">
          Used {rule.uses.toLocaleString()} time{rule.uses === 1 ? '' : 's'}
          {rule.given > 0 ? `, ${money(rule.given)} given away` : ''}
          {rule.limits.budget != null ? ` of a ${money(rule.limits.budget)} budget` : ''}.
        </p>
        {waiting ? (
          <p role="status" className="text-sm text-amber-700">
            Waiting for approval before it goes in force. It cannot be changed until it is decided.
            You can withdraw the request under{' '}
            <Link href="/admin/approvals/inbox" className="underline">
              Approvals
            </Link>
            .
          </p>
        ) : null}
        {rule.approvalStatus === 'rejected' ? (
          <p role="status" className="text-sm text-red-700">
            The approvers refused this rule. Change it and ask again.
          </p>
        ) : null}
        {rule.status === 'active' ? (
          <p className="text-xs text-fg-muted">
            A rule that is pricing sales cannot be edited. Pause it, change it, then put it back in
            force.
          </p>
        ) : null}
        {!retired && detail.issues.length > 0 ? (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800"
          >
            <p className="font-semibold">
              {rule.status === 'active' ? 'Needs attention:' : 'Before this can go in force:'}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {detail.issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {!retired && detail.warnings.length > 0 ? (
          <ul role="status" className="list-disc space-y-0.5 pl-5 text-xs text-amber-700">
            {detail.warnings.map((w, n) => (
              <li key={n}>{w.message}</li>
            ))}
          </ul>
        ) : null}
        {detail.overlaps.length > 0 ? (
          <p role="status" className="text-xs text-amber-700">
            It looks the same as {detail.overlaps.join(', ')}, which is already in force: the best
            one will apply, not both.
          </p>
        ) : null}
      </section>

      {action ? (
        <section aria-label="Confirm" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            {action === 'activate'
              ? 'Put this rule in force? Sales it applies to are priced with it from then on, unless an approval is required first.'
              : action === 'pause'
                ? 'Pause this rule? It stops reducing prices at once. You can change it and put it back in force.'
                : 'Retire this rule? It stops reducing prices and cannot be put back in force. Its history stays.'}
          </p>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={action === 'retire' ? dangerButtonClass : primaryButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void confirm()}
            >
              {busy
                ? 'Working…'
                : action === 'activate'
                  ? 'Put in force'
                  : action === 'pause'
                    ? 'Pause'
                    : 'Retire'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setAction(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      <Notice message={message} />

      {editing && canEdit ? (
        <DiscountForm
          mode="edit"
          initial={rule}
          lookups={lookups}
          productNames={productNames}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setMessage({ kind: 'ok', text: 'Saved. It is a new version.' });
            router.refresh();
          }}
        />
      ) : null}

      {rule.requiresCoupon || detail.coupons.length > 0 ? (
        <Coupons detail={detail} canManage={canManage && !retired} />
      ) : null}

      {retired ? null : <RuleImpactPanel ruleId={rule.id} />}

      <DiscountSimulator
        tryRule={rule.status === 'active' || retired ? null : { id: rule.id, code: rule.code }}
      />

      <section aria-label="Recent use" className={`${cardClass} space-y-2`}>
        <h3 className="text-sm font-bold text-fg-strong">Recent use</h3>
        {detail.recentUsage.length === 0 ? (
          <p className="text-sm text-fg-muted">Nobody has used this rule yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {detail.recentUsage.map((u, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {u.kind === 'reversal' ? (
                    <Chip tone="grey">Given back</Chip>
                  ) : (
                    <Chip tone="green">Used</Chip>
                  )}{' '}
                  <span className="font-mono text-xs">{u.documentId}</span>
                  {u.couponCode ? ` with ${u.couponCode}` : ''}
                </span>
                <span className="font-mono text-xs">
                  {money(u.amount)} · <When iso={u.occurredAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="History" className={`${cardClass} space-y-2`}>
        <h3 className="text-sm font-bold text-fg-strong">History</h3>
        <ul className="divide-y divide-line text-sm">
          {detail.events.map((e) => (
            <li key={e.id} className="py-2">
              <span className="font-semibold text-fg-strong">{EVENTS[e.action] ?? e.action}</span>{' '}
              <span className="text-xs text-fg-muted">
                <When iso={e.occurredAt} />
                {e.reasonCode ? ` · ${e.reasonCode.replace(/_/g, ' ').toLowerCase()}` : ''}
                {e.reasonText ? ` · ${e.reasonText}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Coupons({ detail, canManage }: { detail: DiscountDetail; canManage: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [mode, setMode] = useState<'typed' | 'random'>('random');
  const [typed, setTyped] = useState('');
  const [count, setCount] = useState('10');
  const [prefix, setPrefix] = useState('');
  const [validTo, setValidTo] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [perCustomer, setPerCustomer] = useState('1');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string[]>([]);

  const add = async () => {
    setBusy(true);
    setMessage(null);
    const r = await createCouponsAction(
      detail.rule.id,
      {
        ...(mode === 'typed'
          ? { codes: typed.split(/[\s,;]+/).filter(Boolean) }
          : { generate: { count: Number(count), prefix: prefix || undefined } }),
        validTo: fromLocalInput(validTo),
        maxUses: maxUses ? Number(maxUses) : null,
        maxUsesPerCustomer: perCustomer ? Number(perCustomer) : null,
      },
      reason,
    );
    setBusy(false);
    if (r.ok) {
      setMade(r.data.created);
      setMessage({
        kind: 'ok',
        text: `${r.data.created.length} code${r.data.created.length === 1 ? '' : 's'} added.`,
      });
      setTyped('');
      setReason({ code: '', text: '' });
      router.refresh();
    } else setMessage({ kind: 'error', text: r.error });
  };

  const toggle = async (id: string, status: 'active' | 'disabled') => {
    if (!reason.code) return setMessage({ kind: 'error', text: 'Choose a reason first.' });
    setBusy(true);
    const r = await setCouponStatusAction(id, status, reason);
    setBusy(false);
    if (r.ok) router.refresh();
    else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <section aria-label="Coupons" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">
        Coupon codes ({detail.coupons.length.toLocaleString()}
        {detail.coupons.length >= 200 ? '+' : ''})
      </h3>
      {canManage ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex min-h-10 cursor-pointer items-center gap-2">
              <input
                type="radio"
                name={`${uid}-mode`}
                className="size-4"
                checked={mode === 'random'}
                onChange={() => setMode('random')}
              />
              Make random codes
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-2">
              <input
                type="radio"
                name={`${uid}-mode`}
                className="size-4"
                checked={mode === 'typed'}
                onChange={() => setMode('typed')}
              />
              Type the codes
            </label>
          </div>
          {mode === 'random' ? (
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <div>
                <label htmlFor={`${uid}-n`} className={labelClass}>
                  How many
                </label>
                <input
                  id={`${uid}-n`}
                  type="number"
                  min={1}
                  max={1000}
                  className={fieldClass}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-p`} className={labelClass}>
                  Starts with (optional)
                </label>
                <input
                  id={`${uid}-p`}
                  className={fieldClass}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="XMAS"
                />
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor={`${uid}-t`} className={labelClass}>
                Codes, separated by commas, spaces or new lines
              </label>
              <textarea
                id={`${uid}-t`}
                rows={3}
                className={fieldClass}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={`${uid}-e`} className={labelClass}>
                Expires (optional)
              </label>
              <input
                id={`${uid}-e`}
                type="datetime-local"
                className={fieldClass}
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-u`} className={labelClass}>
                Uses per code (optional)
              </label>
              <input
                id={`${uid}-u`}
                type="number"
                min={1}
                className={fieldClass}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-c`} className={labelClass}>
                Uses per customer
              </label>
              <input
                id={`${uid}-c`}
                type="number"
                min={1}
                className={fieldClass}
                value={perCustomer}
                onChange={(e) => setPerCustomer(e.target.value)}
              />
            </div>
          </div>
          <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy || !reason.code}
            onClick={() => void add()}
          >
            {busy ? 'Adding…' : 'Add codes'}
          </button>
        </div>
      ) : null}
      <Notice message={message} />
      {made.length > 0 ? (
        <div className="rounded-lg border border-line p-3">
          <p className="mb-1 text-xs font-semibold text-fg-strong">New codes (copy them now)</p>
          <textarea
            readOnly
            aria-label="New codes"
            rows={Math.min(8, made.length)}
            className={`${fieldClass} font-mono text-xs`}
            value={made.join('\n')}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      ) : null}
      {detail.coupons.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No codes yet. The rule cannot be used until it has one.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <thead className="border-b border-line text-fg-muted">
              <tr>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Valid until</th>
                <th className="py-2 pr-3 text-right">Used</th>
                <th className="py-2 pr-3">Limits</th>
                <th className="py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {detail.coupons.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-3 font-mono font-semibold text-fg-strong">{c.code}</td>
                  <td className="py-2 pr-3">
                    {c.validTo ? new Date(c.validTo).toLocaleDateString('en-KE') : 'No end'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {c.uses}
                    {c.maxUses != null ? ` / ${c.maxUses}` : ''}
                  </td>
                  <td className="py-2 pr-3 text-fg-muted">
                    {c.maxUsesPerCustomer != null ? `${c.maxUsesPerCustomer} per customer` : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {canManage ? (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() =>
                          void toggle(c.id, c.status === 'active' ? 'disabled' : 'active')
                        }
                      >
                        {c.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                    ) : (
                      <Chip tone={c.status === 'active' ? 'green' : 'grey'}>
                        {c.status === 'active' ? 'Active' : 'Disabled'}
                      </Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
