'use client';

import { Chip, buttonClass, primaryClass } from '@/components/ui/screen-kit';
import { estimateCost, volumeFit, type GeoProviderInfo, type Judgement, type Level, type UsageProfile } from '@/lib/geo-providers';
import type { ProviderMetrics } from '@/lib/geo-metrics';

const TONE: Record<Level, 'green' | 'sky' | 'amber' | 'red'> = { good: 'green', ok: 'sky', watch: 'amber', poor: 'red' };
const WORD: Record<Level, string> = { good: 'Good', ok: 'Fair', watch: 'Watch', poor: 'Weak' };

function buttonWords(ready: boolean, inUse: boolean): string {
  if (inUse) return 'Change its settings';
  return ready ? 'Choose this one' : 'Not available yet';
}

const usd = (n: number): string => `US$${n.toLocaleString('en-KE', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

function Row({ label, level, children }: { label: string; level?: Level; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg">
        {label}
        {level === undefined ? null : <Chip tone={TONE[level]}>{WORD[level]}</Chip>}
      </dt>
      <dd className="text-sm text-fg-muted">{children}</dd>
    </div>
  );
}

function Judged({ j }: { j: Judgement }) {
  return (
    <>
      {j.text}
      {j.ours === true ? <span className="text-xs italic"> (our view, not the provider’s)</span> : null}
    </>
  );
}

/** What was seen with this business's own use of the service. Evidence, not a promise. */
function Observed({ m }: { m: ProviderMetrics | undefined }) {
  if (m === undefined) return <>No calls yet in the last 30 days. Choose it and this fills in from your own use.</>;
  return (
    <>
      {m.calls.toLocaleString('en-KE')} calls: {m.successPercent}% worked, {m.within1000Percent}% answered within a second, {m.fallbackPercent}% fell back to the estimate. Average {m.averageMs} ms, slowest {m.maxMs} ms.
    </>
  );
}

/**
 * One map service laid out for choosing: what it costs for this business's volume, how it behaved here, what it limits and
 * demands. Every card has the same rows in the same order, so two can be compared by reading across.
 */
export function MapProviderCard({
  info,
  usage,
  kesPerUsd,
  metrics,
  inUse,
  may,
  onChoose,
}: {
  info: GeoProviderInfo;
  usage: UsageProfile;
  kesPerUsd: number | null;
  metrics: ProviderMetrics | undefined;
  inUse: boolean;
  may: boolean;
  onChoose: () => void;
}) {
  const cost = estimateCost(info.id, usage);
  const fit = volumeFit(info.id, usage);
  return (
    <section aria-label={info.name} className={`flex min-w-0 flex-col gap-4 rounded-xl border p-4 ${inUse ? 'border-indigo-500 bg-indigo-500/5' : 'border-line bg-surface-raised'}`}>
      <header className="space-y-1">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-fg-strong">
          {info.name}
          {inUse ? <Chip tone="sky">In use</Chip> : null}
          {info.adapterReady ? null : <Chip tone="gray">Not installed yet</Chip>}
        </h3>
        <p className="text-sm text-fg-muted">{info.tagline}</p>
      </header>

      <div className="rounded-lg border border-line bg-surface p-3" role="group" aria-label={`${info.name}: cost at your volume`}>
        <p className="text-xs font-semibold text-fg">At your volume, a month costs</p>
        {cost.kind === 'known' ? (
          <>
            <p className="text-lg font-semibold text-fg-strong">
              {cost.totalUsd === 0 ? 'Nothing: inside the free allowance' : `about ${usd(cost.totalUsd)}`}
              {cost.totalUsd > 0 && kesPerUsd !== null ? <span className="text-sm font-normal text-fg-muted"> (about KES {Math.round(cost.totalUsd * kesPerUsd).toLocaleString('en-KE')})</span> : null}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
              {cost.lines.map((l) => (
                <li key={l.label}>
                  {l.label}: {l.units.toLocaleString('en-KE')} (first {l.freeUnits.toLocaleString('en-KE')} free) = {usd(l.usd)}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-fg-strong">{cost.note}</p>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          <Chip tone={TONE[fit.level]}>{WORD[fit.level]}</Chip> {fit.text}
        </p>
      </div>

      <dl className="space-y-3">
        <Row label="Price and billing" level={info.cost.level}>
          <Judged j={info.cost} />
        </Row>
        <Row label="Reliability" level={info.reliability.level}>
          <Judged j={info.reliability} />
        </Row>
        <Row label="How it has behaved for you">
          <Observed m={metrics} />
        </Row>
        <Row label="Limits" level={info.limits.level}>
          <Judged j={info.limits} />
        </Row>
        <Row label="Search while typing" level={info.typeahead.level}>
          <Judged j={info.typeahead} />
        </Row>
        <Row label="Road distance and time" level={info.roadDistance.level}>
          <Judged j={info.roadDistance} />
        </Row>
        <Row label="Kenyan places and addresses" level={info.kenyaData.level}>
          <Judged j={info.kenyaData} />
        </Row>
        {info.terms.length === 0 ? null : (
          <Row label="What its terms ask of you">
            <ul className="list-disc space-y-0.5 pl-4">
              {info.terms.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="Best for">{info.bestFor}</Row>
        {info.watchOut.length === 0 ? null : (
          <Row label="Watch out for">
            <ul className="list-disc space-y-0.5 pl-4">
              {info.watchOut.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </Row>
        )}
      </dl>

      {info.sources.length === 0 ? null : (
        <p className="text-xs text-fg-muted">
          Read the source:{' '}
          {info.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 ? ', ' : ''}
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                {s.label}
              </a>
            </span>
          ))}
        </p>
      )}

      <div className="mt-auto pt-1">
        {may ? (
          <button type="button" className={inUse ? buttonClass : primaryClass} disabled={!info.adapterReady} onClick={onChoose} aria-label={inUse ? `Change the settings of ${info.name}` : `Choose ${info.name}`}>
            {buttonWords(info.adapterReady, inUse)}
          </button>
        ) : null}
      </div>
    </section>
  );
}
