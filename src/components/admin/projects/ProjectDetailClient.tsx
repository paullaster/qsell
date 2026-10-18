'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { projectPayload, projectProblem, taskPayload, taskProblem, type ProjectDraft, type TaskDraft } from '@/lib/project-form';
import { PROJECT_STATUS_INFO, TASK_STATUS_INFO } from '@/lib/project-statuses';
import type { Choice } from '@/lib/payment-options';
import { isProjectStatus } from '@/server/domains/projects/domain/project';
import {
  addProjectTaskAction,
  listProjectTasksAction,
  transitionProjectAction,
  transitionProjectTaskAction,
  updateProjectAction,
  updateProjectTaskAction,
  type projectDetailAction,
} from '@/server/domains/projects/actions';

type View = Extract<Awaited<ReturnType<typeof projectDetailAction>>, { ok: true }>['data'];
type Task = View['tasks'][number];

export function ProjectDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof projectDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <ProjectScreen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function customerWords(name: string | null): string {
  if (name === null || name === '') return 'For the company';
  return name;
}

function stepDone(event: string): string {
  if (event === 'open') return 'Project opened.';
  if (event === 'hold') return 'Project put on hold.';
  if (event === 'resume') return 'Project resumed.';
  if (event === 'complete') return 'Project completed.';
  if (event === 'close') return 'Project closed.';
  if (event === 'cancel') return 'Project cancelled.';
  if (event === 'reopen') return 'Project reopened.';
  return 'Saved.';
}

function eventWords(event: string): string {
  if (event === 'created') return 'Created';
  if (event === 'updated') return 'Details changed';
  if (event === 'task_added') return 'Task added';
  if (event === 'task_updated') return 'Task changed';
  if (event === 'task_completed') return 'Task completed';
  if (event === 'task_cancelled') return 'Task cancelled';
  if (event === 'task_reopened') return 'Task reopened';
  if (event === 'hold') return 'Put on hold';
  if (event === 'open' || event === 'resume' || event === 'reopen') return 'Opened';
  if (event === 'complete') return 'Completed';
  if (event === 'close') return 'Closed';
  if (event === 'cancel') return 'Cancelled';
  return 'Updated';
}

function draftFrom(view: View): ProjectDraft {
  return {
    name: view.project.name,
    description: view.project.description ?? '',
    customerId: view.project.customerId,
    billable: view.project.billable,
    currency: view.project.currency,
    budgetAmount: view.project.budgetAmount,
    startOn: view.project.startOn ?? '',
    endOn: view.project.endOn ?? '',
  };
}

function ProjectScreen({ initial }: { initial: View }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<ProjectDraft>(() => draftFrom(initial));
  const [customer, setCustomer] = useState<Choice | null>(
    initial.project.customerId === null || initial.project.customerName === null
      ? null
      : { id: initial.project.customerId, label: initial.project.customerName },
  );
  const [task, setTask] = useState<TaskDraft>({ code: '', name: '', description: '', budgetAmount: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const { project, capabilities: caps, can } = view;
  const status = isProjectStatus(project.status) ? PROJECT_STATUS_INFO[project.status] : PROJECT_STATUS_INFO.draft;

  const apply = (next: View) => {
    setView(next);
    setForm(draftFrom(next));
    setCustomer(next.project.customerId === null || next.project.customerName === null ? null : { id: next.project.customerId, label: next.project.customerName });
  };

  const chooseCustomer = (choice: Choice | null) => {
    setCustomer(choice);
    setForm((current) => ({ ...current, customerId: choice?.id ?? null }));
  };
  useCustomerCreated((choice) => {
    if (!caps.changeCustomer) return;
    chooseCustomer(choice);
  });

  const step = async (event: string) => {
    setBusy(true);
    const res = await attempt(transitionProjectAction(project.id, event));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    apply(res.data);
    setNotice({ kind: 'ok', text: stepDone(event) });
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = projectProblem(form);
    if (problem !== null) {
      setNotice({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setNotice(null);
    const res = await attempt(updateProjectAction(project.id, { ...projectPayload(form), version: project.version }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    apply(res.data);
    setNotice({ kind: 'ok', text: 'Project saved.' });
  };

  const addTask = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = taskProblem(task);
    if (problem !== null) {
      setNotice({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setNotice(null);
    const res = await attempt(addProjectTaskAction(project.id, taskPayload(task)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    apply(res.data);
    setTask({ code: '', name: '', description: '', budgetAmount: '' });
    setNotice({ kind: 'ok', text: 'Task added.' });
  };

  const moreTasks = async () => {
    if (view.tasksNext === null) return;
    setBusy(true);
    const res = await attempt(listProjectTasksAction(project.id, view.tasksNext));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setView({ ...view, tasks: [...view.tasks, ...res.data.tasks], tasksNext: res.data.tasksNext });
  };

  const afterTask = (res: Awaited<ReturnType<typeof updateProjectTaskAction>>, ok: string) => {
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    apply(res.data);
    setNotice({ kind: 'ok', text: ok });
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={project.name}
        intro={`${project.number} · ${customerWords(project.customerName)}`}
        actions={<Link href="/admin/projects" className={buttonClass}>All projects</Link>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={status.tone}>{status.label}</Chip>
        <span className="text-xs text-fg-muted">{project.billable ? 'Sold to a customer' : 'Not sold'}</span>
      </div>
      <Message notice={notice} />
      <div className="flex flex-wrap gap-2">
        {caps.open && can.open ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void step('open')}>Open project</button> : null}
        {caps.hold && can.hold ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void step('hold')}>Put on hold</button> : null}
        {caps.resume && can.open ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void step('resume')}>Resume</button> : null}
        {caps.complete && can.complete ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void step('complete')}>Mark completed</button> : null}
        {caps.reopen && can.open ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void step('reopen')}>Reopen</button> : null}
        {caps.close && can.close ? <InlineConfirm label={`Close project ${project.number}`} action="Close" confirm="Close for good" busy={busy} onConfirm={() => void step('close')} /> : null}
        {caps.cancel && can.cancel ? <InlineConfirm label={`Cancel project ${project.number}`} action="Cancel project" confirm="Cancel for good" busy={busy} onConfirm={() => void step('cancel')} /> : null}
      </div>

      {caps.edit && can.update ? (
        <form className={`${cardClass} space-y-4`} aria-label="Project details" onSubmit={(e) => void save(e)}>
          <Field id={`${uid}-name`} label="Name">
            <input id={`${uid}-name`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
          </Field>
          {caps.changeCustomer ? (
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
          ) : (
            <p className="text-sm text-fg">{customerWords(project.customerName)}</p>
          )}
          <Field id={`${uid}-desc`} label="Description" hint="Optional.">
            <textarea id={`${uid}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={fieldClass} rows={3} maxLength={2000} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-cur`} label="Currency">
              <input id={`${uid}-cur`} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} className={fieldClass} required maxLength={3} readOnly={!caps.changeCurrency} autoComplete="off" />
            </Field>
            <Field id={`${uid}-budget`} label="Budget">
              <input id={`${uid}-budget`} inputMode="decimal" value={form.budgetAmount} onChange={(e) => setForm({ ...form, budgetAmount: e.target.value })} className={fieldClass} autoComplete="off" />
            </Field>
            <Field id={`${uid}-start`} label="Starts">
              <input id={`${uid}-start`} type="date" value={form.startOn} onChange={(e) => setForm({ ...form, startOn: e.target.value })} className={fieldClass} />
            </Field>
            <Field id={`${uid}-end`} label="Ends">
              <input id={`${uid}-end`} type="date" value={form.endOn} onChange={(e) => setForm({ ...form, endOn: e.target.value })} className={fieldClass} />
            </Field>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={form.billable} onChange={(e) => setForm({ ...form, billable: e.target.checked })} className="h-4 w-4" />
            This work is sold to a customer
          </label>
          {project.budgetNote !== null ? <p role="status" className="text-sm text-amber-700">{project.budgetNote}</p> : null}
          <button type="submit" className={primaryClass} disabled={busy}>Save changes</button>
        </form>
      ) : (
        <div className={cardClass}>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-semibold text-fg-muted">Customer</dt><dd className="text-fg">{customerWords(project.customerName)}</dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">Budget</dt><dd className="text-fg">{project.currency} {money(project.budgetAmount)}</dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">Starts</dt><dd className="text-fg">{project.startOn ?? 'Not set'}</dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">Ends</dt><dd className="text-fg">{project.endOn ?? 'Not set'}</dd></div>
          </dl>
          {project.description !== null && project.description !== '' ? <p className="mt-3 text-sm text-fg">{project.description}</p> : null}
          {project.budgetNote !== null ? <p role="status" className="mt-3 text-sm text-amber-700">{project.budgetNote}</p> : null}
        </div>
      )}

      <section className="space-y-3" aria-labelledby={`${uid}-tasks`}>
        <h3 id={`${uid}-tasks`} className="text-sm font-bold text-fg-strong">Tasks</h3>
        {view.tasks.length === 0 ? <p className="text-sm text-fg-muted">No tasks yet.</p> : (
          <ul className="space-y-2">
            {view.tasks.map((item) => (
              <TaskRow
                key={item.id}
                task={item}
                busy={busy}
                canEdit={can.update}
                onSave={async (draft) => {
                  setBusy(true);
                  const res = await attempt(updateProjectTaskAction(project.id, item.id, { ...taskPayload(draft), version: item.version }));
                  afterTask(res, 'Task saved.');
                  return res.ok;
                }}
                onStep={async (event) => {
                  setBusy(true);
                  const res = await attempt(transitionProjectTaskAction(project.id, item.id, event));
                  afterTask(res, stepDone(event));
                }}
              />
            ))}
          </ul>
        )}
        {view.tasksNext !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void moreTasks()}>Show more tasks</button> : null}
        {caps.addTask && can.update ? (
          <form className={`${cardClass} space-y-3`} aria-label="Add a task" onSubmit={(e) => void addTask(e)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-code`} label="Code" hint="Letters, numbers and hyphens.">
                <input id={`${uid}-code`} value={task.code} onChange={(e) => setTask({ ...task, code: e.target.value.toUpperCase() })} className={fieldClass} required maxLength={20} autoComplete="off" />
              </Field>
              <Field id={`${uid}-task-name`} label="Task name">
                <input id={`${uid}-task-name`} value={task.name} onChange={(e) => setTask({ ...task, name: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
              </Field>
              <Field id={`${uid}-task-budget`} label="Task budget" hint="Leave empty for none.">
                <input id={`${uid}-task-budget`} inputMode="decimal" value={task.budgetAmount} onChange={(e) => setTask({ ...task, budgetAmount: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-task-desc`} label="Note" hint="Optional.">
                <input id={`${uid}-task-desc`} value={task.description} onChange={(e) => setTask({ ...task, description: e.target.value })} className={fieldClass} maxLength={2000} autoComplete="off" />
              </Field>
            </div>
            <button type="submit" className={primaryClass} disabled={busy}>Add task</button>
          </form>
        ) : null}
      </section>

      <section className="space-y-2" aria-labelledby={`${uid}-history`}>
        <h3 id={`${uid}-history`} className="text-sm font-bold text-fg-strong">What happened</h3>
        {view.events.length === 0 ? <p className="text-sm text-fg-muted">Nothing has been recorded yet.</p> : (
          <ol className="space-y-1 text-sm text-fg">
            {view.events.map((event) => (
              <li key={event.id}>
                {eventWords(event.event)} · {event.actor} · {event.when}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function TaskRow({
  task,
  busy,
  canEdit,
  onSave,
  onStep,
}: {
  task: Task;
  busy: boolean;
  canEdit: boolean;
  onSave: (draft: TaskDraft) => Promise<boolean>;
  onStep: (event: string) => Promise<void>;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft>({ code: task.code, name: task.name, description: task.description ?? '', budgetAmount: task.budgetAmount });
  const info = TASK_STATUS_INFO[task.status];

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const found = taskProblem(draft);
    if (found !== null) {
      setProblem(found);
      return;
    }
    setProblem(null);
    const saved = await onSave(draft);
    if (saved) setOpen(false);
  };

  return (
    <li className={`${cardClass} space-y-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-bold text-fg-strong">
          {task.code} <span className="font-normal text-fg">{task.name}</span>
        </p>
        <Chip tone={info.tone}>{info.label}</Chip>
      </div>
      <p className="text-xs text-fg-muted">{money(task.budgetAmount)}{task.description === null || task.description === '' ? '' : ` · ${task.description}`}</p>
      <div className="flex flex-wrap gap-2">
        {task.capabilities.edit && canEdit ? <button type="button" className={buttonClass} disabled={busy} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Change'}</button> : null}
        {task.capabilities.complete && canEdit ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void onStep('complete')}>Mark done</button> : null}
        {task.capabilities.reopen && canEdit ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void onStep('reopen')}>Reopen task</button> : null}
        {task.capabilities.cancel && canEdit ? <InlineConfirm label={`Cancel task ${task.code}`} action="Cancel task" confirm="Cancel this task" busy={busy} onConfirm={() => void onStep('cancel')} /> : null}
      </div>
      {open ? (
        <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={`Change task ${task.code}`} onSubmit={(e) => void save(e)}>
          {problem !== null ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p> : null}
          <Field id={`${uid}-code`} label="Code"><input id={`${uid}-code`} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} className={fieldClass} required maxLength={20} autoComplete="off" /></Field>
          <Field id={`${uid}-name`} label="Task name"><input id={`${uid}-name`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" /></Field>
          <Field id={`${uid}-budget`} label="Task budget"><input id={`${uid}-budget`} inputMode="decimal" value={draft.budgetAmount} onChange={(e) => setDraft({ ...draft, budgetAmount: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
          <Field id={`${uid}-note`} label="Note"><input id={`${uid}-note`} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={fieldClass} maxLength={2000} autoComplete="off" /></Field>
          <button type="submit" className={primaryClass} disabled={busy}>Save task</button>
        </form>
      ) : null}
    </li>
  );
}
