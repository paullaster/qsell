'use client';

import { Suspense, use, useId, useState } from 'react';
import { signingDocumentsPageAction, signingFlowAction, type SigningEventView } from '@/server/domains/kra/signing/actions';
import { SIGNING_MODULE_LABELS, isSigningModule } from '@/server/domains/kra/signing/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, Chip, fieldClass, LoadFailed, PageHeader } from '@/components/ui/screen-kit';
import { isOutcome, OUTCOME_LABEL, reasonWords, type SigningOutcomeId } from '@/lib/kra-signing-log';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';

type FirstPage = Extract<Awaited<ReturnType<typeof signingDocumentsPageAction>>, { ok: true }>;

const OUTCOME_TONE = { sign: 'green', skip: 'gray', fail: 'red', defer: 'amber' } as const;
const GATE_STYLE = { pass: 'text-emerald-700', skip: 'text-amber-700', fail: 'text-red-700' } as const;

export function SigningLogClient({ firstPage }: { firstPage: ReturnType<typeof signingDocumentsPageAction> }) {
  const first = use(firstPage);
  return first.ok ? <SigningLog first={first} /> : <LoadFailed error={first.error} />;
}

function SigningLog({ first }: { first: FirstPage }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<Choice | null>(null);
  const [open, setOpen] = useState<{ key: string; flow: ReturnType<typeof signingFlowAction> } | null>(null);

  const chosen: SigningOutcomeId | undefined = isOutcome(outcome?.id) ? outcome.id : undefined;
  const list = usePagedList<SigningEventView, { query: string; outcome: SigningOutcomeId | undefined }>({
    load: (filters, cursor) => signingDocumentsPageAction({ query: filters.query, outcome: filters.outcome, cursor }),
    filters: { query: query.trim(), outcome: chosen },
    initialPage: first,
  });

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Signing log" intro="Every document that was considered for signing with KRA, the settings that applied, and why. A document that was not signed is recorded the same way as one that was." />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={`${uid}-q`} className="mb-1 block text-xs font-semibold text-fg">
            Find a document
          </label>
          <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Order number or id" className={fieldClass} autoComplete="off" />
        </div>
        <div className="sm:w-56">
          <ChoicePicker label="Latest result" source="kra-signing-outcomes" choice={outcome} onChoice={setOutcome} placeholder="All" />
        </div>
      </div>

      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-subtle">No documents match.</p> : null}

      <ul className="space-y-3" aria-label="Documents">
        {list.rows.map((latest) => (
          <li key={latest.documentKey} className="rounded-xl border border-line bg-surface-raised">
            <DocumentRow
              latest={latest}
              flow={open?.key === latest.documentKey ? open.flow : null}
              // The story is asked for when the row is opened, in the click, not while drawing.
              onToggle={() => setOpen(open?.key === latest.documentKey ? null : { key: latest.documentKey, flow: signingFlowAction(latest.documentKey) })}
            />
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more documents'}
        </button>
      )}
    </div>
  );
}

function DocumentRow({ latest, flow, onToggle }: { latest: SigningEventView; flow: ReturnType<typeof signingFlowAction> | null; onToggle: () => void }) {
  const ref = latest.documentRef ?? latest.documentId;
  return (
    <div>
      <button type="button" aria-expanded={flow !== null} onClick={onToggle} className="flex min-h-12 w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-left">
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-fg-strong">
            {ref} <span className="text-xs font-normal text-fg-muted">{latest.documentType.replace('_', ' ')} · {isSigningModule(latest.module) ? SIGNING_MODULE_LABELS[latest.module] : latest.module}</span>
          </span>
          <span className="block text-xs text-fg-muted">{reasonWords(latest.reason)}</span>
        </span>
        <Chip tone={OUTCOME_TONE[latest.outcome]}>{OUTCOME_LABEL[latest.outcome]}</Chip>
      </button>
      {flow === null ? null : (
        <Suspense
          fallback={
            <p role="status" className="border-t border-line px-4 py-3 text-sm text-fg-muted">
              Loading the steps…
            </p>
          }
        >
          <Flow flow={flow} />
        </Suspense>
      )}
    </div>
  );
}

/** The whole story of one document, read when it is opened. */
function Flow({ flow }: { flow: ReturnType<typeof signingFlowAction> }) {
  const res = use(flow);
  if (!res.ok) {
    return (
      <p role="alert" className="border-t border-line px-4 py-3 text-sm text-red-700">
        {res.error}
      </p>
    );
  }
  const events = res.data;
  return (
    <ol className="space-y-4 border-t border-line px-4 py-3">
      {events.map((e) => (
        <li key={e.id} className="space-y-2 text-xs">
          <p className="font-semibold text-fg-strong">
            {e.eventType === 'decision' ? 'Decision' : 'Signing attempt'} · <span className="font-normal text-fg-muted">{new Date(e.createdAt).toLocaleString()}</span>
          </p>
          <p className="text-fg-muted">
            {OUTCOME_LABEL[e.outcome]}: {reasonWords(e.reason)}
            {e.scope === null ? '' : ` · ${e.scope} settings`}
            {e.mode === null ? '' : ` · ${e.mode === 'etims' ? 'eTIMS' : 'TIMS'}`}
          </p>
          {has(e.error) ? (
            <p role="alert" className="text-red-700">
              {e.error}
            </p>
          ) : null}
          {has(e.scuReceiptNo) ? (
            <p className="text-fg-muted">
              KRA receipt <span className="font-mono">{e.scuReceiptNo}</span>
              {has(e.verificationUrl) ? (
                <>
                  {' · '}
                  <a href={e.verificationUrl} target="_blank" rel="noreferrer" className="font-semibold text-indigo-500 underline">
                    Verify
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {e.gates.length > 0 ? (
            <ul className="space-y-1 rounded-lg bg-surface-sunken/60 p-3">
              {e.gates.map((g) => (
                <li key={`${g.gate}-${g.detail}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                  <span className={`w-28 shrink-0 font-semibold uppercase ${GATE_STYLE[g.result]}`}>{g.gate.replaceAll('_', ' ')}</span>
                  <span className="text-fg">
                    {g.detail} <span className="text-fg-muted">({g.source})</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
