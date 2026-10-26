'use client';

import { use, useId, useState } from 'react';
import { ArrowDown, ArrowUp, FileText, Plus, Save, Trash2 } from 'lucide-react';
import { type companyPoliciesAction, saveCompanyPoliciesAction } from '@/server/domains/company/actions';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { policyAddress, POLICY_LIMITS, type PolicyPage } from '@/config/company-ui';

const fieldClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const labelClass = 'mb-1 block text-xs font-semibold tracking-wider text-fg-subtle uppercase';
const iconBtnClass =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted hover:text-fg-strong disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-500';

const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
};

/** Suggestions for what a shop usually needs; nothing is filled in until the company adds it. */
const SUGGESTED = ['Privacy policy', 'Terms of service', 'Delivery and shipping', 'Returns and refunds'];

export function AdminCompanyPoliciesClient({ policiesPromise }: { policiesPromise: ReturnType<typeof companyPoliciesAction> }) {
  const loaded = use(policiesPromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <PoliciesForm initial={loaded.data} />;
}

function PageField({ page, label, children }: { page: PolicyPage; label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={`${id}-${page.id}`} className={labelClass}>{label}</label>
      {children(`${id}-${page.id}`)}
    </div>
  );
}

function PoliciesForm({ initial }: { initial: PolicyPage[] }) {
  const [pages, setPages] = useState<PolicyPage[]>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const change = (id: string, changes: Partial<PolicyPage>) => setPages((list) => list.map((page) => (page.id === id ? { ...page, ...changes } : page)));
  const add = (title: string) => setPages((list) => [...list, { id: globalThis.crypto.randomUUID(), slug: '', title, body: '' }]);

  const save = async () => {
    setMessage(null);
    setError(null);
    setPending(true);
    const result = await attempt(saveCompanyPoliciesAction(pages));
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Shown as stored: incomplete pages are dropped and addresses made unique on the server.
    setPages(result.data);
    setMessage('Policy pages saved. The shop now shows them in its footer.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong"><FileText className="h-5 w-5 text-indigo-400" aria-hidden="true" />Policy pages</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Privacy, delivery, returns and any other page the shop links from its footer. Write plain text: a blank line starts a new paragraph, a line starting with “# ” is a heading and lines starting with “- ” make a list. Nothing is pre-filled, because these pages must say what is true for your business.
          </p>
        </div>
        <button type="button" onClick={() => void save()} disabled={pending} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          <Save className="h-4 w-4" aria-hidden="true" />{pending ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div aria-live="polite">{message === null ? null : <div role="status" className="rounded-lg border border-emerald-800 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}</div>
      {error === null ? null : <div role="alert" className="rounded-lg border border-red-800 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <ul className="space-y-4">
        {pages.map((page, index) => (
          <li key={page.id} className="space-y-3 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5">
            <PageField page={page} label={`Title of page ${String(index + 1)}`}>
              {(id) => <input id={id} className={fieldClass} maxLength={POLICY_LIMITS.title} value={page.title} onChange={(e) => change(page.id, { title: e.target.value })} />}
            </PageField>
            <PageField page={page} label={`Text of page ${String(index + 1)}`}>
              {(id) => <textarea id={id} rows={10} className={fieldClass} maxLength={POLICY_LIMITS.body} value={page.body} onChange={(e) => change(page.id, { body: e.target.value })} />}
            </PageField>
            {page.slug === '' ? <p className="text-xs text-fg-muted">The page address is made from the title when you save.</p> : <p className="text-xs text-fg-muted">Address: <span className="font-mono">{policyAddress(page)}</span></p>}
            <div className="flex gap-2">
              <button type="button" className={iconBtnClass} disabled={index === 0} onClick={() => setPages((list) => move(list, index, index - 1))} aria-label={`Move page ${String(index + 1)} up`}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={iconBtnClass} disabled={index === pages.length - 1} onClick={() => setPages((list) => move(list, index, index + 1))} aria-label={`Move page ${String(index + 1)} down`}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" className={`${iconBtnClass} hover:text-red-600`} onClick={() => setPages((list) => list.filter((item) => item.id !== page.id))} aria-label={`Remove page ${String(index + 1)}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pages.length >= POLICY_LIMITS.pages} onClick={() => add('')} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-line bg-surface px-4 py-2 text-sm font-medium text-fg-strong hover:border-indigo-500 disabled:opacity-50">
          <Plus className="h-4 w-4" aria-hidden="true" />Add a page
        </button>
        {SUGGESTED.filter((title) => !pages.some((page) => page.title === title)).map((title) => (
          <button key={title} type="button" disabled={pages.length >= POLICY_LIMITS.pages} onClick={() => add(title)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg hover:border-indigo-500 disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{title}
          </button>
        ))}
      </div>
    </div>
  );
}
