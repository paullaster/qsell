'use client';

import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { emptyProjectDraft, projectPayload, projectProblem, projectRoute, type ProjectDraft } from '@/lib/project-form';
import type { Choice } from '@/lib/payment-options';
import { createProjectAction, type projectStartAction } from '@/server/domains/projects/actions';

type Start = Extract<Awaited<ReturnType<typeof projectStartAction>>, { ok: true }>['data'];

export function NewProjectClient({ startPromise }: { startPromise: ReturnType<typeof projectStartAction> }) {
  const start = use(startPromise);
  return start.ok ? <NewProjectView start={start.data} /> : <LoadFailed error={start.error} />;
}

function NewProjectView({ start }: { start: Start }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<ProjectDraft>({ ...emptyProjectDraft(), currency: start.currency });
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const nonce = useRef<string | null>(null);

  const chooseCustomer = (choice: Choice | null) => {
    setCustomer(choice);
    setForm((current) => ({ ...current, customerId: choice?.id ?? null, billable: choice === null ? current.billable : true }));
  };
  useCustomerCreated(chooseCustomer);

  const set = (patch: Partial<ProjectDraft>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = projectProblem(form);
    if (problem !== null) {
      setNotice({ kind: 'error', text: problem });
      return;
    }
    nonce.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const res = await attempt(createProjectAction({ ...projectPayload(form), idempotencyKey: nonce.current }));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(projectRoute(res.data.id));
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="New project"
        intro="A piece of work for a customer, or for the company itself. It stays a draft until you open it."
      />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-4`} aria-label="New project" onSubmit={(e) => void save(e)}>
        <Field id={`${uid}-name`} label="Name">
          <input id={`${uid}-name`} value={form.name} onChange={(e) => set({ name: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
        </Field>
        <ChoicePicker
          label="Customer"
          source="project-customers"
          choice={customer}
          onChoice={chooseCustomer}
          placeholder="Leave empty for work the company does for itself"
          listHref="/admin/customers"
          listLabel="View all customers"
          createHref="/admin/customers/new"
          createLabel="+ Create a customer"
        />
        <Field id={`${uid}-desc`} label="Description" hint="Optional.">
          <textarea id={`${uid}-desc`} value={form.description} onChange={(e) => set({ description: e.target.value })} className={fieldClass} rows={3} maxLength={2000} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-cur`} label="Currency" hint="Three letters. The budget is kept in this currency.">
            <input id={`${uid}-cur`} value={form.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} className={fieldClass} required maxLength={3} autoComplete="off" />
          </Field>
          <Field id={`${uid}-budget`} label="Budget" hint="Leave empty for no budget yet.">
            <input id={`${uid}-budget`} inputMode="decimal" value={form.budgetAmount} onChange={(e) => set({ budgetAmount: e.target.value })} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-start`} label="Starts">
            <input id={`${uid}-start`} type="date" value={form.startOn} onChange={(e) => set({ startOn: e.target.value })} className={fieldClass} />
          </Field>
          <Field id={`${uid}-end`} label="Ends">
            <input id={`${uid}-end`} type="date" value={form.endOn} onChange={(e) => set({ endOn: e.target.value })} className={fieldClass} />
          </Field>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={form.billable} onChange={(e) => set({ billable: e.target.checked })} className="h-4 w-4" />
          This work is sold to a customer
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryClass} disabled={busy}>Save project</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => router.push('/admin/projects')}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
