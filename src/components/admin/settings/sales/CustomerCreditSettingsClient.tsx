'use client';

import { use, useState } from 'react';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import {
  Chip,
  LoadFailed,
  Message,
  PageHeader,
  attempt,
  buttonClass,
  cardClass,
  primaryClass,
  type Notice,
} from '@/components/ui/screen-kit';
import { creditLimitDisplayLabel, type CreditLimitDisplay } from '@/lib/customer-credit-settings';
import {
  type customerCreditSettingsScreenAction,
  saveCustomerCreditDisplayAction,
  setAllowOverCreditLimitAction,
  type CustomerCreditSettingsActionView,
} from '@/server/domains/customers/credit-settings-actions';
import { ReasonField, reasonReady, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof customerCreditSettingsScreenAction>>;

const emptyReason = (): ReasonValue => ({ code: '', text: '' });

export function CustomerCreditSettingsClient({
  firstPromise,
}: {
  firstPromise: ReturnType<typeof customerCreditSettingsScreenAction>;
}) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: CustomerCreditSettingsActionView }) {
  const [view, setView] = useState(initial);
  const [display, setDisplay] = useState<CreditLimitDisplay>(initial.creditLimitDisplay);
  const [displayReason, setDisplayReason] = useState<ReasonValue>(emptyReason);
  const [overLimitReason, setOverLimitReason] = useState<ReasonValue>(emptyReason);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const saveDisplay = async () => {
    setBusy(true);
    setNotice(null);
    if (!reasonReady(displayReason)) {
      setBusy(false);
      setNotice({
        kind: 'error',
        text: 'Choose a reason for changing what the credit screen shows.',
      });
      return;
    }
    const res = await attempt(saveCustomerCreditDisplayAction(display, displayReason));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setView(res.data);
    setDisplayReason(emptyReason());
    setNotice({
      kind: 'ok',
      text: res.data.message ?? 'Saved. The new display applies straight away.',
    });
  };

  const setOverLimit = async (enabled: boolean) => {
    setBusy(true);
    setNotice(null);
    if (!reasonReady(overLimitReason)) {
      setBusy(false);
      setNotice({ kind: 'error', text: 'Choose a reason before changing this control.' });
      return;
    }
    const res = await attempt(setAllowOverCreditLimitAction(enabled, overLimitReason));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setView(res.data);
    setOverLimitReason(emptyReason());
    setNotice({
      kind: 'ok',
      text:
        res.data.message ??
        (enabled
          ? 'Turned on. Over-limit orders follow approval workflows where configured; otherwise they are created.'
          : 'Turned off. Over-limit orders are refused again.'),
    });
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Customer credit"
        intro="Choose what the credit figure shows. Order and checkout checks always use the customer's set credit limit less what they owe."
      />
      <Message notice={notice} />
      <section className={cardClass}>
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-bold text-fg-strong">Credit shown to staff and shoppers</h2>
            <p className="text-xs text-fg-muted">
              Running shows the set limit less the net amount owed. Static shows only the set limit.
              This choice changes what people see, not what the system checks.
            </p>
          </div>
          <ChoicePicker
            label="Credit display"
            source="customer-credit-limit-displays"
            placeholder="Choose how credit is shown…"
            choice={{ id: display, label: creditLimitDisplayLabel(display) }}
            onChoice={(choice) => {
              if (choice?.id === 'running' || choice?.id === 'static') setDisplay(choice.id);
            }}
          />
          <ReasonField value={displayReason} onChange={setDisplayReason} source="selling-reasons" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryClass}
              onClick={() => void saveDisplay()}
              disabled={busy || display === view.creditLimitDisplay}
            >
              Save display
            </button>
          </div>
        </div>
      </section>
      <section className={cardClass}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-fg-strong">
                Proceeding beyond available credit
              </h2>
              <p className="text-xs text-fg-muted">
                Off refuses an order that would pass the available credit. On sends it to an
                approval workflow when one is configured; with no workflow, the order is created.
              </p>
            </div>
            <Chip tone={view.allowOverCreditLimit ? 'green' : 'gray'}>
              {view.allowOverCreditLimit ? 'On' : 'Off'}
            </Chip>
          </div>
          <ReasonField
            value={overLimitReason}
            onChange={setOverLimitReason}
            source="selling-reasons"
          />
          <div className="flex flex-wrap gap-2">
            {view.allowOverCreditLimit ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => void setOverLimit(false)}
                disabled={busy}
              >
                Turn off
              </button>
            ) : (
              <InlineConfirm
                label="Turn on proceeding beyond available credit"
                action="Turn on"
                confirm="Yes, turn it on"
                busy={busy}
                onConfirm={() => void setOverLimit(true)}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
