'use client';

import { useId, useMemo, useState } from 'react';
import type { SigningEventView } from '@/server/domains/kra/signing/actions';
import { SIGNING_MODULE_LABELS, isSigningModule } from '@/server/domains/kra/signing/types';

import { has } from '@/lib/values';

const REASON_TEXT: Record<string, string> = {
  SIGN: 'Signed with KRA',
  PROFORMA_NEVER_SIGNED: 'Proforma invoices are never signed',
  KRA_NOT_CONFIGURED: 'KRA is not configured',
  SIGNING_NOT_ENABLED_FOR_MODE: 'Signing is not enabled for the mode',
  ORIGINAL_NOT_SIGNED: 'The original invoice was not signed, so there is nothing to reverse',
  ORIGINAL_NOT_YET_SIGNED: 'Waiting for the original invoice to be signed',
  MODULE_DISABLED: 'Signing is off for this module',
  UNSUPPORTED_DOCUMENT_TYPE: 'This document type does not go through this path',
  CUSTOMER_OPTED_OUT: 'The customer opted out',
  BRANCH_NOT_FOUND: 'Branch not found',
  BRANCH_INACTIVE: 'Branch is inactive',
  BRANCH_CONFIG_MISSING: 'The independent branch has no KRA configuration',
  COMPANY_CONFIG_MISSING: 'No company KRA configuration',
  CONFIG_DISABLED: 'The KRA configuration is disabled',
  CONFIG_INCOMPLETE: 'The KRA configuration is incomplete',
  MODE_MISMATCH: 'The mode does not match',
  ITEMS_NOT_REGISTERED: 'Items are not registered with KRA',
  TIMS_SIGNING_UNAVAILABLE: 'TIMS signing is not available yet',
  TRANSMISSION_FAILED: 'KRA did not accept the invoice',
  UNEXPECTED_ERROR: 'Unexpected error',
};

const OUTCOME_STYLE = {
  sign: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
  skip: 'border-line bg-surface-sunken text-fg-muted',
  fail: 'border-red-500/20 bg-red-500/10 text-red-700',
  defer: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
} as const;

const GATE_STYLE = {
  pass: 'text-emerald-700',
  skip: 'text-amber-700',
  fail: 'text-red-700',
} as const;

const OUTCOME_LABEL = {
  sign: 'Signed',
  skip: 'Not signed',
  fail: 'Failed',
  defer: 'Waiting on original',
} as const;

interface DocumentFlow {
  key: string;
  ref: string;
  module: string;
  documentType: string;
  /** Oldest first. */
  events: SigningEventView[];
  latest: SigningEventView;
}

function groupByDocument(events: SigningEventView[]): DocumentFlow[] {
  const map = new Map<string, SigningEventView[]>();
  for (const e of events) map.set(e.documentKey, [...(map.get(e.documentKey) ?? []), e]);
  return [...map.entries()].map(([key, list]) => {
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = ordered[ordered.length - 1]!;
    return {
      key,
      ref: latest.documentRef ?? latest.documentId,
      module: latest.module,
      documentType: latest.documentType,
      events: ordered,
      latest,
    };
  });
}

export function SigningLogClient({ events }: { events: SigningEventView[] }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<'all' | 'sign' | 'skip' | 'fail' | 'defer'>('all');

  const flows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByDocument(events).filter(
      (f) =>
        (outcome === 'all' || f.latest.outcome === outcome) &&
        (!has(q) || f.ref.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)),
    );
  }, [events, query, outcome]);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-fg-strong">Signing log</h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Every document that was considered for signing with KRA, the settings that applied, and
          why. A document that was not signed is recorded the same way as one that was.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label htmlFor={`${uid}-q`} className="mb-1 block text-xs font-semibold text-fg">
            Find a document
          </label>
          <input
            id={`${uid}-q`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Order number or id"
            className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor={`${uid}-o`} className="mb-1 block text-xs font-semibold text-fg">
            Latest result
          </label>
          <select
            id={`${uid}-o`}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none sm:w-48"
          >
            <option value="all">All</option>
            <option value="sign">Signed</option>
            <option value="skip">Not signed</option>
            <option value="fail">Failed</option>
            <option value="defer">Waiting on original</option>
          </select>
        </div>
      </div>

      {flows.length === 0 ? (
        <p className="text-sm text-fg-subtle">No documents match.</p>
      ) : (
        <ul className="space-y-3">
          {flows.map((flow) => (
            <li key={flow.key} className="rounded-xl border border-line bg-surface-raised">
              <details>
                <summary className="flex min-h-12 cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-fg-strong">
                      {flow.ref}{' '}
                      <span className="text-xs font-normal text-fg-muted">
                        {flow.documentType.replace('_', ' ')} ·{' '}
                        {isSigningModule(flow.module)
                          ? SIGNING_MODULE_LABELS[flow.module]
                          : flow.module}
                      </span>
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {REASON_TEXT[flow.latest.reason] ?? flow.latest.reason}
                    </span>
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_STYLE[flow.latest.outcome]}`}
                  >
                    {OUTCOME_LABEL[flow.latest.outcome]}
                  </span>
                </summary>
                <ol className="space-y-4 border-t border-line px-4 py-3">
                  {flow.events.map((e) => (
                    <li key={e.id} className="space-y-2 text-xs">
                      <p className="font-semibold text-fg-strong">
                        {e.eventType === 'decision' ? 'Decision' : 'Signing attempt'} ·{' '}
                        <span className="font-normal text-fg-muted">
                          {new Date(e.createdAt).toLocaleString()}
                        </span>
                      </p>
                      <p className="text-fg-muted">
                        {OUTCOME_LABEL[e.outcome]}: {REASON_TEXT[e.reason] ?? e.reason}
                        {e.scope ? ` · ${e.scope} settings` : ''}
                        {e.mode ? ` · ${e.mode === 'etims' ? 'eTIMS' : 'TIMS'}` : ''}
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
                              <a
                                href={e.verificationUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-semibold text-indigo-500 underline"
                              >
                                Verify
                              </a>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      {e.gates.length > 0 ? (
                        <ul className="space-y-1 rounded-lg bg-surface-sunken/60 p-3">
                          {e.gates.map((g, i) => (
                            <li key={i} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                              <span
                                className={`w-28 shrink-0 font-semibold uppercase ${GATE_STYLE[g.result]}`}
                              >
                                {g.gate.replaceAll('_', ' ')}
                              </span>
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
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
