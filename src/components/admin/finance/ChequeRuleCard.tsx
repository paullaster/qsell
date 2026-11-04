'use client';

import { useState } from 'react';
import { recheckOrderPaymentsAction, setChequeRuleAction } from '@/server/domains/finance/receivables/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CHEQUE_COUNTS_CHOICES, type ChequeCountsMode } from '@/lib/order-payment';
import type { Choice } from '@/lib/payment-options';
import { Message, buttonClass, cardClass, type Notice, attempt } from './ui';

const choiceOf = (mode: ChequeCountsMode): Choice => {
  const found = CHEQUE_COUNTS_CHOICES.find((c) => c.id === mode);
  return { id: mode, label: found?.label ?? mode };
};

/** The company's rule for when a cheque makes an order paid. Only people allowed to change finance settings can save it. */
export function ChequeRuleCard({ mode, canEdit }: { mode: ChequeCountsMode; canEdit: boolean }) {
  const [saved, setSaved] = useState<ChequeCountsMode>(mode);
  const [choice, setChoice] = useState<Choice>(choiceOf(mode));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(setChequeRuleAction(choice.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSaved(choice.id as ChequeCountsMode);
    const n = res.data.moved;
    setNotice({ kind: 'ok', text: n === 0 ? 'Saved. No order changed.' : `Saved. ${String(n)} ${n === 1 ? 'order was' : 'orders were'} updated to match.` });
  };

  const recheck = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(recheckOrderPaymentsAction());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const { checked, moved } = res.data;
    setNotice({ kind: 'ok', text: `Checked ${String(checked)} ${checked === 1 ? 'invoice' : 'invoices'}; ${String(moved)} ${moved === 1 ? 'order was' : 'orders were'} updated.` });
  };

  return (
    <section className={`${cardClass} space-y-3`} aria-label="When a cheque counts as payment">
      <div>
        <h2 className="text-sm font-bold text-fg-strong">When a cheque counts as payment</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Decides when an invoice shows as paid for a cheque. Waiting for the cheque to clear is safest, because a cheque can bounce.
          Cash, bank and M-Pesa receipts count straight away. Changing the rule updates the orders it affects. &ldquo;Re-check all
          orders&rdquo; brings every order&apos;s payment state in step with the receipts, wallet use and credit notes on its invoices, which is
          how orders from before this feature are caught up.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="A cheque counts" source="cheque-count-modes" choice={choice} onChoice={(c) => c !== null && setChoice(c)} clearable={false} disabled={!canEdit} />
        {canEdit ? (
          <div className="flex items-end">
            <button type="button" className={buttonClass} onClick={() => void save()} disabled={busy || choice.id === saved}>Save rule</button>
            <button type="button" className={`${buttonClass} ml-2`} onClick={() => void recheck()} disabled={busy}>Re-check all orders</button>
          </div>
        ) : null}
      </div>
      <Message notice={notice} />
    </section>
  );
}
