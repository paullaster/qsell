'use client';

import { use, useId, useState } from 'react';
import { branchSwitchesPageAction, companySwitchesAction, setSwitchAction, type BranchSwitchView, type SwitchView } from '@/server/kernel/approvals/actions';
import { MODULE_LABELS, TRIGGERS } from '@/server/kernel/approvals/domain/triggers';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { effectiveSwitch, labelIn, ON_OFF, parseScope, switchQuestion } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { Chip, Notice, PageHeader, buttonClass, cardClass, primaryButtonClass, type Message } from './shared';

const modules = [...new Set(TRIGGERS.map((t) => t.module))];
type FirstBranchPage = Extract<Awaited<ReturnType<typeof branchSwitchesPageAction>>, { ok: true }>;

interface Pending extends SwitchView {
  branchLabel: string | null;
}

interface Props {
  companyPromise: ReturnType<typeof companySwitchesAction>;
  branchPromise: ReturnType<typeof branchSwitchesPageAction>;
}

export function SwitchesClient({ companyPromise, branchPromise }: Props) {
  const company = use(companyPromise);
  const branches = use(branchPromise);
  if (!company.ok) return <LoadFailed error={company.error} />;
  if (!branches.ok) return <LoadFailed error={branches.error} />;
  return <Switches initial={company.data.company} firstBranches={branches} />;
}

function Switches({ initial, firstBranches }: { initial: SwitchView[]; firstBranches: FirstBranchPage }) {
  const uid = useId();
  const [company, setCompany] = useState(initial);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState<Choice | null>(null);
  const [scope, setScope] = useState<Choice | null>(null);
  const [state, setState] = useState<Choice>({ id: 'false', label: labelIn(ON_OFF, 'false') });

  const list = usePagedList<BranchSwitchView, Record<string, never>>({
    load: (_filters, cursor) => branchSwitchesPageAction({ cursor }),
    filters: {},
    initialPage: firstBranches,
  });

  const apply = async () => {
    if (pending === null) return;
    setBusy(true);
    setMessage(null);
    const { branchLabel: _label, ...input } = pending;
    const res = await attempt(setSwitchAction(input, reason));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    const fresh = await attempt(companySwitchesAction());
    if (fresh.ok) setCompany(fresh.data.company);
    list.reload();
    setPending(null);
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text: 'Saved. It applies to documents submitted from now on; requests already waiting are not affected.' });
  };

  const toggle = (module: string, trigger: string | null) => setPending({ module, trigger, branchId: null, enabled: !effectiveSwitch(company, module, trigger).on, branchLabel: null });
  const triggerLabelOf = (code: string | null) => (code === null ? null : (TRIGGERS.find((t) => t.code === code)?.label ?? code));
  const areaLabel = (m: string) => MODULE_LABELS[m] ?? m;

  const setException = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const parsed = scope === null ? null : parseScope(scope.id);
    if (branch === null || parsed === null) return;
    setPending({ module: parsed.module, trigger: parsed.trigger, branchId: branch.id, enabled: state.id === 'true', branchLabel: branch.label });
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Approval switches">
        Turn approvals off for a whole area or for one situation. A situation follows its area unless you set it separately. When approvals are off, documents go ahead without asking anyone.
      </PageHeader>

      <Notice message={message} />

      {pending === null ? null : (
        <form
          className={`${cardClass} space-y-4 border-indigo-500`}
          aria-label="Confirm switch change"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <p className="text-sm font-semibold text-fg-strong">
            {switchQuestion({ enabled: pending.enabled, areaLabel: areaLabel(pending.module), triggerLabel: triggerLabelOf(pending.trigger), branchLabel: pending.branchLabel })}
          </p>
          <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || reason.code === ''}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {modules.map((m) => {
        const mod = effectiveSwitch(company, m, null);
        return (
          <section key={m} className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-${m}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id={`${uid}-${m}`} className="text-sm font-bold text-fg-strong">
                {areaLabel(m)}
              </h3>
              <SwitchButton on={mod.on} label={`${areaLabel(m)} approvals`} onClick={() => toggle(m, null)} />
            </div>
            <ul className="divide-y divide-line">
              {TRIGGERS.filter((t) => t.module === m).map((t) => {
                const e = effectiveSwitch(company, m, t.code);
                return (
                  <li key={t.code} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span className="text-sm text-fg">
                      {t.label} {e.inherited ? <Chip tone="grey">follows {areaLabel(m)}</Chip> : <Chip tone="sky">set separately</Chip>}
                    </span>
                    <SwitchButton on={e.on} label={t.label} onClick={() => toggle(m, t.code)} />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-branch`}>
        <h3 id={`${uid}-branch`} className="text-sm font-bold text-fg-strong">
          Branch exceptions
        </h3>
        <p className="text-sm text-fg-muted">A switch for one branch wins over the company-wide one.</p>
        {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">No branch exceptions.</p> : null}
        <ul className="space-y-1.5" aria-label="Branch exceptions">
          {list.rows.map((s) => (
            <li key={`${s.branchId ?? ''}-${s.module}-${s.trigger ?? ''}`} className="text-sm text-fg">
              {s.branchLabel}: {triggerLabelOf(s.trigger) ?? areaLabel(s.module)} <Chip tone={s.enabled ? 'green' : 'grey'}>{s.enabled ? 'On' : 'Off'}</Chip>
            </li>
          ))}
        </ul>
        {list.cursor === null ? null : (
          <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
            {list.phase === 'more' ? 'Loading…' : 'Show more exceptions'}
          </button>
        )}
        <form className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]" onSubmit={setException} aria-label="New branch exception">
          <ChoicePicker label="Branch" source="approval-branches" choice={branch} onChoice={setBranch} placeholder="Choose a branch…" required />
          <ChoicePicker label="Applies to" source="approval-switch-scopes" choice={scope} onChoice={setScope} placeholder="Choose an area or situation…" required />
          <ChoicePicker label="Approvals" source="approval-on-off" choice={state} onChoice={(c) => setState(c ?? state)} clearable={false} />
          <button type="submit" className={buttonClass} disabled={branch === null || scope === null}>
            Set exception…
          </button>
        </form>
      </section>
    </div>
  );
}

function SwitchButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex min-h-10 min-w-24 cursor-pointer items-center justify-center rounded-full border px-4 text-xs font-bold focus-visible:outline-2 focus-visible:outline-indigo-500 ${on ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-line-strong bg-surface-sunken text-fg-muted'}`}
    >
      {on ? 'On' : 'Off'}
    </button>
  );
}

