'use client';

import { useState } from 'react';
import { impactOfRuleAction } from '@/server/domains/pricing/insights-actions';
import type { RuleImpact } from '@/server/domains/pricing/insights-service';
import { Notice, buttonClass, cardClass, type Message } from '../approvals/shared';
import { money } from './DiscountsClient';

/** What a rule would have cost over recent sales: a price tag before it goes in force. */
export function RuleImpactPanel({ ruleId }: { ruleId: string }) {
  const [impact, setImpact] = useState<RuleImpact | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const r = await impactOfRuleAction(ruleId, 90);
    setBusy(false);
    if (r.ok) setImpact(r.data);
    else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <section aria-label="What it would have cost" className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-fg-strong">What would this have cost?</h2>
          <p className="text-xs text-fg-muted">
            Applies the rule to the last 90 days of real sales. It assumes customers buy the same
            either way, so it is the price of the offer, not a forecast of demand.
          </p>
        </div>
        <button type="button" className={buttonClass} onClick={() => void run()} disabled={busy}>
          {busy ? 'Working it out…' : impact ? 'Work it out again' : 'Work it out'}
        </button>
      </div>
      <Notice message={message} />
      {impact ? (
        impact.supported ? (
          <div role="status" className="space-y-2">
            <p className="text-sm text-fg-strong">
              It would have given away <strong>{money(impact.giveaway)}</strong>
              {impact.matched.net > 0
                ? ` (${impact.giveawayPercent}% of ${money(impact.matched.net)} sold)`
                : ''}
              , about <strong>{money(impact.yearly)}</strong> a year.
            </p>
            {impact.marginBeforePercent != null ? (
              <p className="text-sm text-fg">
                Margin on those sales would go from {impact.marginBeforePercent}% to{' '}
                <strong>{impact.marginAfterPercent}%</strong>.
              </p>
            ) : (
              <p className="text-sm text-fg-muted">
                No cost is on record for these sales, so no margin is shown.
              </p>
            )}
            <ul className="list-disc pl-5 text-xs text-fg-muted">
              {impact.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p role="status" className="text-sm text-fg-muted">
            {impact.unsupportedReason}
          </p>
        )
      ) : null}
    </section>
  );
}
