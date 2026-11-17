'use client';

import { use, useState } from 'react';
import { saveBusinessTimeAction, type businessTimeScreenAction } from '@/server/domains/company/business-time-actions';
import type { BusinessTimeView } from '@/server/domains/company/business-time-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { LoadFailed, Message, PageHeader, attempt, cardClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof businessTimeScreenAction>>;

export function BusinessTimeClient({ firstPromise }: { firstPromise: ReturnType<typeof businessTimeScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: BusinessTimeView }) {
  const [view, setView] = useState(initial);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = picked?.id ?? '';
  const changed = chosen !== '' && chosen !== view.timeZone;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const r = await attempt(saveBusinessTimeAction(chosen, reason));
    setBusy(false);
    if (!r.ok) {
      setProblem(r.error);
      return;
    }
    setView(r.data);
    setPicked(null);
    setReason({ code: '', text: '' });
    setNotice({ kind: 'ok', text: `The business time zone is now ${r.data.timeZone}. Everything made from now on follows it.` });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Business time zone"
        intro="The time zone the business works in. It decides which day a sale or a posting belongs to, when quiet hours for text messages start and end, the hours of a delivery window or a visit, and where a report’s day begins and ends."
      />
      <Message notice={notice} />
      <section aria-label="The business time zone now" className={cardClass}>
        <h2 className="text-sm font-bold text-fg-strong">Now</h2>
        <p className="mt-1 text-lg font-semibold text-fg-strong">{view.timeZone}</p>
        <p className="text-sm text-fg-muted">
          {view.offset === '' ? '' : `${view.offset} · `}
          the clock there reads {view.localNow}
        </p>
      </section>
      <form
        aria-label="Change the business time zone"
        className={`${cardClass} space-y-4`}
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <ChoicePicker
          label="Business time zone"
          source="business-timezones"
          choice={picked ?? { id: view.timeZone, label: view.timeZone }}
          onChoice={(c) => setPicked(c)}
          clearable={false}
          placeholder="Search for a city or region, such as Nairobi…"
        />
        <p className="text-xs text-fg-muted">
          Documents already made keep the dates they have. Only what is made after the change follows the new zone, so change it when the day is quiet and check the clock above afterwards.
        </p>
        <ReasonField value={reason} onChange={setReason} source="business-time-reasons" />
        <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}</div>
        <div className="flex flex-wrap items-center gap-3">
          <InlineConfirm
            label="Change the business time zone"
            action="Change the time zone"
            confirm="Yes, change it"
            busy={busy || !changed || reason.code === ''}
            onConfirm={() => void save()}
          />
          {!changed ? <p className="text-xs text-fg-muted">Choose a different time zone to change it.</p> : null}
          {changed && reason.code === '' ? <p className="text-xs text-fg-muted">Choose a reason to change it.</p> : null}
        </div>
      </form>
    </div>
  );
}
