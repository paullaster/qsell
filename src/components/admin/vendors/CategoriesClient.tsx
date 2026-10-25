'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveCategoryAction, type categoriesAction } from '@/server/domains/vendors/prequal-actions';
import { emptyCategory } from '@/lib/prequalification';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Rows = Extract<Awaited<ReturnType<typeof categoriesAction>>, { ok: true }>['data'];

const CAT_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'gray' | 'sky' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  open: { label: 'Open for applications', tone: 'green' },
  closed: { label: 'Closed', tone: 'amber' },
  archived: { label: 'Archived', tone: 'gray' },
};

export function CategoriesClient({ initialPromise }: { initialPromise: ReturnType<typeof categoriesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <CategoriesView rows={res.data} /> : <LoadFailed error={res.error} />;
}

function CategoriesView({ rows }: { rows: Rows }) {
  const uid = useId();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveCategoryAction(null, { ...emptyCategory(), ...form }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/admin/vendors/categories/${res.data.id}`);
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Procurement categories"
        intro="What a vendor can be qualified for. Set the questions and documents a vendor must provide, then open the category for applications."
        actions={<span className="flex items-center gap-3"><Link href="/admin/vendors/prequalification" className="text-sm font-semibold text-indigo-600 hover:underline">Applications</Link><button type="button" className={primaryClass} onClick={() => { setAdding(true); setNotice(null); }}>Add a category</button></span>}
      />
      <Message notice={notice} />
      {adding ? (
        <form onSubmit={(e) => void create(e)} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2`} aria-label="Add a category">
          <Field id={`${uid}-c`} label="Code" hint="Capital letters, digits, dots, dashes. It cannot be changed later."><input id={`${uid}-c`} value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))} className={fieldClass} required maxLength={30} autoComplete="off" /></Field>
          <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className={fieldClass} required maxLength={120} autoComplete="off" /></Field>
          <div className="flex gap-2 sm:col-span-2"><button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Create and set up'}</button><button type="button" className={buttonClass} onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      ) : null}
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No categories yet. Add the first one.</p> : (
        <ul className="space-y-2" aria-label="Categories">
          {rows.map((r) => {
            const s = CAT_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/categories/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.name}</span><span className="block text-xs text-fg-muted">{r.code}{r.parent === null ? '' : ` · inside ${r.parent}`} · {r.validityMonths} months</span></span>
                  <span className="flex items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip>{r.qualified > 0 ? <Chip tone="green">{r.qualified} qualified</Chip> : null}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
