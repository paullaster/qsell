'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  listConfigReasonsAction,
  setSwitchAction,
  type Lookups,
  type SwitchView,
} from '@/server/kernel/approvals/actions';
import { MODULE_LABELS, TRIGGERS } from '@/server/kernel/approvals/domain/triggers';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from './shared';

const modules = [...new Set(TRIGGERS.map((t) => t.module))];

/** The explicit switch for this scope, if one was set (company-wide ones; branch ones are listed apart). */
const explicit = (list: SwitchView[], module: string, trigger: string | null) =>
  list.find((s) => s.module === module && s.trigger === trigger && s.branchId === null);

export function SwitchesClient({
  switches,
  lookups,
}: {
  switches: SwitchView[];
  lookups: Lookups;
}) {
  const uid = useId();
  const router = useRouter();
  const [pending, setPending] = useState<SwitchView | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState({
    module: modules[0]!,
    trigger: '',
    branchId: lookups.branches[0]?.id ?? '',
    enabled: false,
  });

  const effective = (module: string, trigger: string | null) => {
    const t = trigger ? explicit(switches, module, trigger) : undefined;
    if (t) return { on: t.enabled, inherited: false };
    const m = explicit(switches, module, null);
    if (m) return { on: m.enabled, inherited: trigger !== null };
    return { on: true, inherited: true };
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    setMessage(null);
    const res = await setSwitchAction(pending, reason);
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    setPending(null);
    setReason({ code: '', text: '' });
    setMessage({
      kind: 'ok',
      text: 'Saved. It applies to documents submitted from now on; requests already waiting are not affected.',
    });
    router.refresh();
  };

  const toggle = (module: string, trigger: string | null) =>
    setPending({ module, trigger, branchId: null, enabled: !effective(module, trigger).on });

  const branchName = (id: string | null) =>
    lookups.branches.find((b) => b.id === id)?.name ?? 'Unknown branch';
  const branchSwitches = switches.filter((s) => s.branchId !== null);

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Approval switches">
        Turn approvals off for a whole area or for one situation. A situation follows its area
        unless you set it separately. When approvals are off, documents go ahead without asking
        anyone.
      </PageHeader>

      <Notice message={message} />

      {pending ? (
        <form
          className={`${cardClass} space-y-4 border-indigo-500`}
          aria-label="Confirm switch change"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <p className="text-sm font-semibold text-fg-strong">
            Turn approvals {pending.enabled ? 'on' : 'off'} for{' '}
            {pending.trigger
              ? TRIGGERS.find((t) => t.code === pending.trigger)?.label
              : `all of ${MODULE_LABELS[pending.module] ?? pending.module}`}
            {pending.branchId ? ` at ${branchName(pending.branchId)}` : ''}?
          </p>
          <ReasonField value={reason} onChange={setReason} load={listConfigReasonsAction} />
          <div className="flex gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || reason.code === ''}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {modules.map((m) => {
        const mod = effective(m, null);
        return (
          <section key={m} className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-${m}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id={`${uid}-${m}`} className="text-sm font-bold text-fg-strong">
                {MODULE_LABELS[m] ?? m}
              </h3>
              <SwitchButton
                on={mod.on}
                label={`${MODULE_LABELS[m] ?? m} approvals`}
                onClick={() => toggle(m, null)}
              />
            </div>
            <ul className="divide-y divide-line">
              {TRIGGERS.filter((t) => t.module === m).map((t) => {
                const e = effective(m, t.code);
                return (
                  <li
                    key={t.code}
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <span className="text-sm text-fg">
                      {t.label}{' '}
                      {e.inherited ? (
                        <Chip tone="grey">follows {MODULE_LABELS[m] ?? m}</Chip>
                      ) : (
                        <Chip tone="sky">set separately</Chip>
                      )}
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
        <p className="text-sm text-fg-muted">
          A switch for one branch wins over the company-wide one.
        </p>
        {branchSwitches.length === 0 ? (
          <p className="text-sm text-fg-muted">No branch exceptions.</p>
        ) : (
          <ul className="space-y-1.5">
            {branchSwitches.map((s, i) => (
              <li key={i} className="text-sm text-fg">
                {branchName(s.branchId)}:{' '}
                {s.trigger
                  ? TRIGGERS.find((t) => t.code === s.trigger)?.label
                  : (MODULE_LABELS[s.module] ?? s.module)}{' '}
                <Chip tone={s.enabled ? 'green' : 'grey'}>{s.enabled ? 'On' : 'Off'}</Chip>
              </li>
            ))}
          </ul>
        )}
        {lookups.branches.length > 0 ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setPending({
                module: override.module,
                trigger: override.trigger || null,
                branchId: override.branchId,
                enabled: override.enabled,
              });
            }}
          >
            <div>
              <label htmlFor={`${uid}-bb`} className={labelClass}>
                Branch
              </label>
              <select
                id={`${uid}-bb`}
                value={override.branchId}
                onChange={(e) => setOverride({ ...override, branchId: e.target.value })}
                className={fieldClass}
              >
                {lookups.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-bt`} className={labelClass}>
                Applies to
              </label>
              <select
                id={`${uid}-bt`}
                value={`${override.module}|${override.trigger}`}
                onChange={(e) => {
                  const [module, trigger] = e.target.value.split('|');
                  setOverride({ ...override, module: module!, trigger: trigger ?? '' });
                }}
                className={fieldClass}
              >
                {modules.map((m) => (
                  <optgroup key={m} label={MODULE_LABELS[m] ?? m}>
                    <option value={`${m}|`}>All of {MODULE_LABELS[m] ?? m}</option>
                    {TRIGGERS.filter((t) => t.module === m).map((t) => (
                      <option key={t.code} value={`${m}|${t.code}`}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-be`} className={labelClass}>
                Approvals
              </label>
              <select
                id={`${uid}-be`}
                value={String(override.enabled)}
                onChange={(e) => setOverride({ ...override, enabled: e.target.value === 'true' })}
                className={fieldClass}
              >
                <option value="false">Off</option>
                <option value="true">On</option>
              </select>
            </div>
            <button type="submit" className={buttonClass}>
              Set exception…
            </button>
          </form>
        ) : null}
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
      className={`inline-flex min-h-10 min-w-24 cursor-pointer items-center justify-center rounded-full border px-4 text-xs font-bold focus-visible:outline-2 focus-visible:outline-indigo-500 ${
        on
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
          : 'border-line-strong bg-surface-sunken text-fg-muted'
      }`}
    >
      {on ? 'On' : 'Off'}
    </button>
  );
}
