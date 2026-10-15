'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { kraBranchesPageAction, type kraCompanyAction, saveBranchKraConfigAction, saveCompanyKraConfigAction, type KraBranchSettingsView, type KraConfigView } from '@/server/domains/kra/actions';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, cardClass, fieldClass, LoadFailed, PageHeader } from '@/components/ui/screen-kit';
import { KraConfigForm } from './KraConfigForm';

interface EmbedProps {
  /** Rendered inside a dialog that already shows the title: skip the page heading. */
  embedded?: boolean;
}

export function KraCompanyModeClient({ companyPromise, embedded = false, onSaved }: EmbedProps & { companyPromise: ReturnType<typeof kraCompanyAction>; onSaved?: () => void }) {
  const res = use(companyPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  const intro = 'Used for every branch that does not act independently. If no company mode is configured and enabled, KRA transmission is refused for those branches.';
  return (
    <div className="max-w-3xl space-y-6">
      {embedded ? <p className="text-sm text-fg-muted">{intro}</p> : <PageHeader title="Company mode" intro={intro} />}
      <div className={embedded ? '' : cardClass}>
        <KraConfigForm scope="company" initial={res.data.company} label="Company" onSave={saveCompanyKraConfigAction} onSaved={onSaved} />
      </div>
    </div>
  );
}

interface BranchProps extends EmbedProps {
  companyPromise: ReturnType<typeof kraCompanyAction>;
  firstPage: ReturnType<typeof kraBranchesPageAction>;
  /** Where the "Branches" link goes. Inside a dialog this is the dialog version of the screen. */
  branchesHref?: string;
  onSaved?: () => void;
}

export function KraBranchModesClient({ companyPromise, firstPage, embedded = false, onSaved, branchesHref = '/admin/settings/branches' }: BranchProps) {
  const company = use(companyPromise);
  const first = use(firstPage);
  if (!company.ok) return <LoadFailed error={company.error} />;
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <BranchModes first={first} company={company.data.company} embedded={embedded} onSaved={onSaved} branchesHref={branchesHref} />;
}

function BranchModes({ first, company, embedded, onSaved, branchesHref }: { first: Extract<Awaited<ReturnType<typeof kraBranchesPageAction>>, { ok: true }>; company: KraConfigView | null; embedded: boolean; onSaved?: () => void; branchesHref: string }) {
  const [query, setQuery] = useState('');
  const list = usePagedList<KraBranchSettingsView, { query: string }>({
    load: (filters, cursor) => kraBranchesPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });
  const intro = 'A branch reads its own mode only when it acts independently. There is no fallback: if an independent branch has no enabled mode, KRA transmission for it is refused.';
  const companyMode = company?.mode ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      {embedded ? <p className="text-sm text-fg-muted">{intro}</p> : <PageHeader title="Branch modes" intro={intro} />}
      <div className="max-w-sm">
        <label htmlFor="kra-branch-search" className="sr-only">
          Search branches
        </label>
        <input id="kra-branch-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
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
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-subtle">{query.trim() === '' ? 'No branches yet.' : `No branch matches “${query.trim()}”.`}</p> : null}
      {list.rows.map((branch) => (
        <section key={branch.id} aria-labelledby={`kra-branch-${branch.id}`} className={cardClass}>
          <h3 id={`kra-branch-${branch.id}`} className="text-base font-bold text-fg-strong">
            {branch.name} <span className="font-mono text-xs text-fg-muted">{branch.code}</span>
          </h3>
          {branch.actsIndependently ? (
            <div className="mt-4">
              <KraConfigForm scope="branch" companyModuleSigning={company?.moduleSigning ?? {}} initial={branch.config} label={branch.name} onSave={(input) => saveBranchKraConfigAction(branch.id, input)} onSaved={onSaved} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">
              Uses the company mode{companyMode === null ? ' (not configured)' : ` (${companyMode === 'etims' ? 'eTIMS' : 'TIMS'})`}. To give this branch its own mode, turn on “acts independently” in{' '}
              <Link href={branchesHref} className="font-semibold text-indigo-500 underline">
                Branches
              </Link>
              .
            </p>
          )}
        </section>
      ))}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more branches'}
        </button>
      )}
    </div>
  );
}
