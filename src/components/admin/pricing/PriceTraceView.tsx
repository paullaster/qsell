'use client';

import type { PriceTrace } from '@/server/domains/pricing/domain/types';
import { Chip } from '../approvals/shared';

const outcome = {
  won: { tone: 'green', label: 'Used' },
  lost: { tone: 'grey', label: 'Not used' },
  not_applicable: { tone: 'grey', label: 'Did not apply' },
} as const;

/**
 * "Why this price?": the recorded steps in plain language, then every price list that was
 * considered with what happened to it. Reads from the trace saved on the line, never recomputes.
 */
export function PriceTraceView({
  trace,
  showCandidates = true,
}: {
  trace: PriceTrace;
  showCandidates?: boolean;
}) {
  return (
    <div className="space-y-3 text-sm">
      <ol className="list-decimal space-y-1 pl-5 text-fg">
        {trace.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {trace.belowFloor ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700"
        >
          This price is below the floor set for it ({trace.floorPrice}).
        </p>
      ) : null}
      {trace.discounts && trace.discounts.applied.length > 0 ? (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-800"
        >
          <p className="font-semibold">
            Discounts, from {trace.discounts.unitPriceBefore.toFixed(2)} each:
          </p>
          <ul className="list-disc pl-5">
            {trace.discounts.applied.map((a, i) => (
              <li key={i}>
                {a.name} ({a.code}): {a.how}, takes off {a.amount.toFixed(2)}
                {a.couponCode ? `, coupon ${a.couponCode}` : ''}
              </li>
            ))}
          </ul>
          {trace.discounts.trimmed > 0 ? (
            <p className="mt-1">
              {trace.discounts.trimmed.toFixed(2)} was held back so the price stays at or above its
              floor.
            </p>
          ) : null}
        </div>
      ) : null}
      {trace.guard && (trace.guard.floorNet != null || trace.guard.overridePercent > 0) ? (
        <div
          role="status"
          className={`rounded-lg border p-2 text-xs ${
            trace.guard.belowFloor || trace.guard.overOverrideLimit
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-800'
              : 'border-line bg-surface-sunken text-fg-muted'
          }`}
        >
          {trace.guard.floorNet != null ? (
            <p>
              Floor {trace.guard.floorNet.toFixed(2)} before tax ({trace.guard.floorSource}).{' '}
              {trace.guard.belowFloor
                ? `This price is ${trace.guard.shortfallPercent}% below it.`
                : 'This price is at or above it.'}
            </p>
          ) : null}
          {trace.guard.overridePercent > 0 ? (
            <p>
              Taken {trace.guard.overridePercent}% below the list price
              {trace.guard.overrideLimitPercent != null
                ? ` (limit ${trace.guard.overrideLimitPercent}%${trace.guard.overOverrideLimit ? ', exceeded' : ''}).`
                : '.'}
            </p>
          ) : null}
        </div>
      ) : null}
      {showCandidates && trace.candidates.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <caption className="sr-only">Price lists considered for this line</caption>
            <thead className="text-fg-muted">
              <tr>
                <th scope="col" className="py-1 pr-3">
                  Source
                </th>
                <th scope="col" className="py-1 pr-3">
                  What happened
                </th>
                <th scope="col" className="py-1 pr-3">
                  Why
                </th>
              </tr>
            </thead>
            <tbody>
              {trace.candidates.map((c, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <th scope="row" className="py-1.5 pr-3 font-semibold text-fg-strong">
                    {c.source === 'standard' ? 'Standard price' : c.listCode}
                    {c.listVersion ? (
                      <span className="font-normal text-fg-muted"> v{c.listVersion}</span>
                    ) : null}
                  </th>
                  <td className="py-1.5 pr-3">
                    <Chip tone={outcome[c.outcome].tone}>{outcome[c.outcome].label}</Chip>
                  </td>
                  <td className="py-1.5 pr-3 text-fg-muted">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
