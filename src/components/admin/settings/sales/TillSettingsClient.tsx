'use client';

import { use, useState } from 'react';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { saveTillSettingsAction, type TillSettingsView, type tillSettingsScreenAction } from '@/server/domains/selling/cash-sales/till-actions';
import type { TillMode } from '@/server/domains/selling/cash-sales/till-rules';

type Loaded = Awaited<ReturnType<typeof tillSettingsScreenAction>>;

const OPTIONS = [
  { value: 'admin', label: 'Inside the admin page' },
  { value: 'fullscreen', label: 'Full-screen till' },
] as const satisfies readonly { value: TillMode; label: string }[];

export function TillSettingsClient({ firstPromise }: { firstPromise: ReturnType<typeof tillSettingsScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: TillSettingsView }) {
  const [saved, setSaved] = useState(initial.tillMode);
  const [mode, setMode] = useState<TillMode>(initial.tillMode);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveTillSettingsAction(mode));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSaved(res.data.tillMode);
    setNotice({ kind: 'ok', text: 'Saved. Tills show this the next time Cash Sales is opened.' });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Cash Sales" intro="Choose how the counter looks for everyone who sells at it." />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-4`}>
        <div>
          <h2 className="text-sm font-bold text-fg-strong">How the counter is shown</h2>
          <p className="text-xs text-fg-muted">
            <strong>Inside the admin page</strong> keeps the menu and header around the till (the default). <strong>Full-screen till</strong> gives
            the whole screen to selling: the products and the sale side by side, a big Pay button, with a small top bar for the shift and Exit.
            It suits a till on a tablet or a counter screen.
          </p>
        </div>
        <SegmentedChoice label="Counter display" value={mode} options={OPTIONS} onChange={setMode} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryClass} disabled={busy || mode === saved} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {mode === saved ? <span className="text-xs text-fg-muted">Showing now: {saved === 'fullscreen' ? 'full-screen till' : 'inside the admin page'}.</span> : null}
        </div>
      </section>
    </div>
  );
}
