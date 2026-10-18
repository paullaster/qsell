'use client';

import Link from 'next/link';
import { use, useState, type SyntheticEvent } from 'react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { usePagedList } from '@/components/ui/usePagedList';
import { projectRoute } from '@/lib/project-form';
import { PROJECT_STATUS_INFO } from '@/lib/project-statuses';
import type { Choice } from '@/lib/payment-options';
import { isProjectStatus } from '@/server/domains/projects/domain/project';
import { listProjectsAction } from '@/server/domains/projects/actions';

type Page = Extract<Awaited<ReturnType<typeof listProjectsAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function ProjectsClient({ initialPromise }: { initialPromise: ReturnType<typeof listProjectsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ProjectsView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function customerWords(name: string | null): string {
  if (name === null || name === '') return 'For the company';
  return name;
}

function ProjectFacts({ row }: { row: Row }) {
  const status = isProjectStatus(row.status) ? PROJECT_STATUS_INFO[row.status] : PROJECT_STATUS_INFO.draft;
  const when = [row.startOn, row.endOn].filter((day): day is string => day !== null && day !== '').join(' – ');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-bold text-fg-strong">
          {row.number} <span className="font-normal text-fg-muted">· {row.name}</span>
        </p>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        {customerWords(row.customerName)} · {row.currency} {money(row.budgetAmount)}
        {when === '' ? '' : ` · ${when}`}
      </p>
    </>
  );
}

function ProjectsView({ initial }: { initial: Page }) {
  const [status, setStatus] = useState<Choice | null>(null);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ status: '', query: '' });
  const list = usePagedList<Row, { status: string; query: string }>({
    initialPage: { ok: true, data: { rows: initial.rows, nextCursor: initial.nextCursor } },
    filters,
    load: async (next, cursor) => {
      const res = await attempt(listProjectsAction({
        status: next.status === '' ? undefined : next.status,
        query: next.query === '' ? undefined : next.query,
        cursor: cursor ?? undefined,
      }));
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { rows: res.data.rows, nextCursor: res.data.nextCursor } };
    },
  });
  const busy = list.phase === 'loading' || list.phase === 'more';
  const notice: Notice = list.phase === 'error' && list.error !== null ? { kind: 'error', text: list.error } : null;

  const show = (e: SyntheticEvent) => {
    e.preventDefault();
    const next = { status: status?.id ?? '', query: q.trim() };
    if (next.status === filters.status && next.query === filters.query) {
      list.reload();
      return;
    }
    setFilters(next);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Projects"
        intro="Work for a customer, or for the company itself. Each project has tasks, a budget and a status that moves one step at a time."
        actions={initial.can.create ? <Link href="/admin/projects/new" className={primaryClass}>New project</Link> : null}
      />
      <Message notice={notice} />
      <form className="flex flex-wrap items-end gap-2" onSubmit={show} role="search">
        <div className="min-w-48">
          <ChoicePicker label="State" source="project-statuses" choice={status} onChoice={setStatus} placeholder="All" />
        </div>
        <label className="min-w-40 flex-1 text-xs font-semibold text-fg-muted">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, name or customer" className={`${fieldClass} mt-1 block w-full`} autoComplete="off" />
        </label>
        <button type="submit" className={buttonClass} disabled={busy}>Show</button>
      </form>
      {list.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No projects match.</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {list.rows.map((row) => (
              <li key={row.id}>
                <Link href={projectRoute(row.id)} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                  <ProjectFacts row={row} />
                </Link>
              </li>
            ))}
          </ul>
          <table className="hidden w-full table-fixed border-collapse text-sm md:table">
            <caption className="sr-only">Projects</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th scope="col" className="px-2 py-2 font-semibold">Number</th>
                <th scope="col" className="px-2 py-2 font-semibold">Name</th>
                <th scope="col" className="px-2 py-2 font-semibold">Customer</th>
                <th scope="col" className="px-2 py-2 font-semibold">State</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Budget</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => {
                const info = isProjectStatus(row.status) ? PROJECT_STATUS_INFO[row.status] : PROJECT_STATUS_INFO.draft;
                return (
                  <tr key={row.id} className="border-b border-line">
                    <td className="px-2 py-3">
                      <Link href={projectRoute(row.id)} className="inline-flex min-h-10 items-center font-bold text-fg-strong underline-offset-2 hover:underline">{row.number}</Link>
                    </td>
                    <td className="px-2 py-3 break-words text-fg">{row.name}</td>
                    <td className="px-2 py-3 break-words text-fg-muted">{customerWords(row.customerName)}</td>
                    <td className="px-2 py-3"><Chip tone={info.tone}>{info.label}</Chip></td>
                    <td className="px-2 py-3 text-right text-fg">{row.currency} {money(row.budgetAmount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {list.cursor !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={list.loadMore}>Show more</button> : null}
    </div>
  );
}
