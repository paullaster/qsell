'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { applyAction, type prequalOverviewAction } from '@/server/domains/vendors/prequal-portal-actions';
import { STATUS_WORDS } from '@/lib/prequalification';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof prequalOverviewAction>>, { ok: true }>['data'];

export function PrequalOverviewClient({ viewPromise }: { viewPromise: ReturnType<typeof prequalOverviewAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Overview view={res.data} /> : <LoadFailed error={res.error} />;
}

const applyLabel = (busy: boolean, n: number): string => {
  if (busy) return 'Starting…';
  return n > 1 ? `Apply for ${String(n)} categories` : 'Apply';
};

function Overview({ view }: { view: View }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const available = view.categories.filter((c) => c.accepting && c.mine === null);

  const apply = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(applyAction(chosen));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const first = res.data.ids[0];
    router.push(first !== undefined && res.data.ids.length === 1 ? `/vendor/prequalification/${first}` : '/vendor/prequalification');
    router.refresh();
    setChosen([]);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Prequalification" intro="Apply to be qualified for the kinds of work you do. You can choose several categories at once; each is decided on its own." actions={<Link href="/vendor" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      {view.notActive ? <p role="status" className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-fg-muted">You can apply once your business profile is approved.</p> : null}

      <section className={`${cardClass} space-y-3`} aria-label="Categories you can apply for">
        <h2 className="text-sm font-bold text-fg-strong">Categories you can apply for</h2>
        {available.length === 0 ? <p className="text-sm text-fg-muted">{view.categories.length === 0 ? 'No category is taking applications right now.' : 'You have already applied for every category that is open.'}</p> : (
          <ul className="space-y-1">
            {available.map((c) => (
              <li key={c.id}>
                <label className="flex min-h-10 cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm">
                  <input type="checkbox" className="mt-0.5 h-5 w-5" checked={chosen.includes(c.id)} disabled={!view.canApply} onChange={(e) => setChosen((l) => (e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id)))} />
                  <span className="min-w-0"><span className="block font-semibold text-fg-strong">{c.name}</span>
                    <span className="block text-xs text-fg-muted">{c.path === '' ? '' : `${c.path} · `}Lasts {c.validityMonths} months{c.description === null ? '' : ` · ${c.description}`}</span>
                    {c.missingDocuments.length === 0 ? null : <span className="block text-xs text-amber-700 dark:text-amber-400">You will need: {c.missingDocuments.join(', ')}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {view.canApply && available.length > 0 ? <button type="button" className={primaryClass} disabled={busy || chosen.length === 0} onClick={() => void apply()}>{applyLabel(busy, chosen.length)}</button> : null}
        {!view.canApply && !view.notActive ? <p className="text-xs text-fg-muted">Only the owner or the sales person can apply.</p> : null}
      </section>

      <section className={`${cardClass} space-y-2`} aria-label="Your applications">
        <h2 className="text-sm font-bold text-fg-strong">Your applications</h2>
        {view.mine.length === 0 ? <p className="text-sm text-fg-muted">You have not applied for anything yet.</p> : (
          <ul className="divide-y divide-line">
            {view.mine.map((m) => {
              const s = STATUS_WORDS[m.status] ?? { label: m.status, tone: 'gray' as const };
              return (
                <li key={m.id}>
                  <Link href={`/vendor/prequalification/${m.id}`} className="flex min-h-10 flex-wrap items-center justify-between gap-2 py-2 text-sm hover:underline">
                    <span className="min-w-0"><span className="block font-semibold text-fg-strong">{m.categoryName}</span>{m.validUntil === null ? null : <span className="block text-xs text-fg-muted">Qualified until {m.validUntil}{m.maxOrderValue === null ? '' : ` · largest order ${m.maxOrderValue}`}</span>}</span>
                    <Chip tone={s.tone}>{s.label}</Chip>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
