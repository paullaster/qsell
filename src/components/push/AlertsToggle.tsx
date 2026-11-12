'use client';

import { useEffect, useState } from 'react';
import { attempt, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import { canPush, subscribeThisBrowser, thisBrowserEndpoint, unsubscribeThisBrowser } from './push-browser';

export interface AlertsState {
  available: boolean;
  publicKey: string | null;
  browsers: number;
}
type Result = { ok: true; data: AlertsState } | { ok: false; error: string };

/**
 * One switch for "alert this browser when a delivery is at risk or late". It says plainly when it cannot work (this browser, or this
 * installation not yet set up) instead of offering a button that does nothing. Used by the Late deliveries screen and the rider app.
 */
export function AlertsToggle({ title, help, workerUrl, scope, load, turnOn, turnOff }: { title: string; help: string; workerUrl: string; scope: string; load: () => Promise<Result>; turnOn: (subscription: { endpoint: string; p256dh: string; auth: string }) => Promise<Result>; turnOff: (input: { endpoint: string }) => Promise<Result> }) {
  const [state, setState] = useState<AlertsState | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const supported = canPush() === 'yes';

  useEffect(() => {
    let live = true;
    void attempt(load()).then(async (r) => {
      if (!live) return;
      if (r.ok) setState(r.data);
      else setProblem(r.error);
      setHere(supported ? (await thisBrowserEndpoint(workerUrl, scope)) !== null : false);
    });
    return () => {
      live = false;
    };
  }, [load, supported, workerUrl, scope]);

  const on = async (publicKey: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const made = await subscribeThisBrowser(workerUrl, scope, publicKey);
    if (!made.ok) {
      setProblem(made.error);
      setBusy(false);
      return;
    }
    const r = await attempt(turnOn(made.subscription));
    if (r.ok) {
      setState(r.data);
      setHere(true);
    } else setProblem(r.error);
    setBusy(false);
  };

  const off = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const endpoint = await unsubscribeThisBrowser(workerUrl, scope);
    if (endpoint !== null) {
      const r = await attempt(turnOff({ endpoint }));
      if (r.ok) setState(r.data);
      else setProblem(r.error);
    }
    setHere(false);
    setBusy(false);
  };

  let body: React.ReactNode;
  if (state === null && problem === null) body = <p className="text-sm text-fg-muted">Checking…</p>;
  else if (state !== null && !state.available) body = <p className="text-sm text-fg-muted">Alerts on phones and computers are not set up on this installation yet. Ask whoever runs it to add the push keys. Emails still go.</p>;
  else if (!supported) body = <p className="text-sm text-fg-muted">This browser cannot show alerts. On an iPhone, add this site to the Home Screen first; otherwise try Chrome, Edge or Firefox.</p>;
  else if (state !== null && state.publicKey !== null) {
    const key = state.publicKey;
    body = here === true ? (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm text-emerald-700">Alerts are on in this browser.</p>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void off()}>
          Turn off
        </button>
      </div>
    ) : (
      <button type="button" className={primaryClass} disabled={busy || here === null} onClick={() => void on(key)}>
        {busy ? 'Turning on…' : 'Turn on alerts in this browser'}
      </button>
    );
  } else body = null;

  return (
    <section aria-label={title} className={`${cardClass} space-y-2`}>
      <h2 className="text-sm font-bold text-fg-strong">{title}</h2>
      <p className="text-xs text-fg-muted">{help}</p>
      {body}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
    </section>
  );
}
