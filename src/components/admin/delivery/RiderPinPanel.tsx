'use client';

import { useState } from 'react';
import { issueRiderPinAction, removeRiderPinAction, unlockRiderPinAction } from '@/server/domains/delivery/rider-actions';
import type { PinStatus } from '@/server/domains/delivery/rider-pins';
import { Chip, attempt, buttonClass, primaryClass } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

function pinBadge(status: PinStatus | null): { tone: 'gray' | 'amber' | 'green' | 'red'; words: string } {
  if (status === null) return { tone: 'gray', words: 'No PIN' };
  if (status.locked !== null) return { tone: 'red', words: `Shut out for ${status.locked.words}` };
  return status.temporary ? { tone: 'amber', words: 'Waiting for the rider to choose their own' } : { tone: 'green', words: 'PIN set' };
}

/**
 * A rider's PIN, for signing in to the rider app with their phone number. The office gives one (shown here once, never kept anywhere),
 * can let a shut-out rider try again, and can turn it off. Giving a new PIN ends the rider's sessions made with the old one.
 */
export function RiderPinPanel({ riderId, riderName, initial, onError }: { riderId: string; riderName: string; initial: PinStatus | null; onError: (text: string) => void }) {
  const [status, setStatus] = useState(initial);
  const [shown, setShown] = useState<{ pin: string; phoneWords: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const give = async () => {
    setBusy(true);
    setNote(null);
    const r = await attempt(issueRiderPinAction({ riderId }));
    setBusy(false);
    if (r.ok) {
      setStatus(r.data.status);
      setShown({ pin: r.data.pin, phoneWords: r.data.status.phoneWords });
    } else onError(r.error);
  };
  const unlock = async () => {
    setBusy(true);
    const r = await attempt(unlockRiderPinAction({ riderId }));
    setBusy(false);
    if (r.ok) {
      setStatus(r.data.status);
      setNote(`${riderName} can try again now.`);
    } else onError(r.error);
  };
  const remove = async () => {
    setBusy(true);
    const r = await attempt(removeRiderPinAction({ riderId }));
    setBusy(false);
    if (r.ok) {
      setStatus(null);
      setShown(null);
      setNote(`${riderName} no longer signs in with a PIN.`);
    } else onError(r.error);
  };

  const badge = pinBadge(status);
  return (
    <section aria-label={`PIN for ${riderName}`} className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-bold text-fg-strong">Sign in with a phone number and PIN</h4>
        <Chip tone={badge.tone}>{badge.words}</Chip>
      </div>
      {status === null ? (
        <p className="text-xs text-fg-muted">The rider signs in with their phone number and a 6-digit PIN you give them, and chooses their own PIN the first time.</p>
      ) : (
        <p className="text-xs text-fg-muted">
          Signs in with {status.phoneWords}
          {status.lastSignedInAt === null ? ' · has not signed in yet' : ` · last signed in ${when(status.lastSignedInAt)}`}
          {status.failedAttempts > 0 && status.locked === null ? ` · ${String(status.failedAttempts)} wrong ${status.failedAttempts === 1 ? 'try' : 'tries'} in a row` : ''}
        </p>
      )}
      {shown === null ? null : (
        <div role="status" aria-label={`New PIN for ${riderName}`} className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <p className="text-sm font-semibold">Give {riderName} this PIN. It is shown only now.</p>
          <p className="font-mono text-2xl font-bold tracking-widest">{shown.pin}</p>
          <p className="text-xs">They sign in with {shown.phoneWords} and this PIN, and choose their own PIN straight away.</p>
          <button type="button" className={buttonClass} onClick={() => setShown(null)}>
            I have given it to them
          </button>
        </div>
      )}
      {note === null ? null : (
        <p role="status" className="text-xs text-fg">
          {note}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {status === null ? (
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void give()}>
            {busy ? 'Working…' : 'Give a PIN'}
          </button>
        ) : (
          <>
            <InlineConfirm label={`Give ${riderName} a new PIN`} action="Give a new PIN" confirm="Yes, give a new PIN" busy={busy} onConfirm={() => void give()} />
            {status.locked === null ? null : (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void unlock()}>
                Let them try again
              </button>
            )}
            <InlineConfirm label={`Turn off the PIN of ${riderName}`} action="Turn off the PIN" confirm="Yes, turn it off" busy={busy} onConfirm={() => void remove()} />
          </>
        )}
      </div>
    </section>
  );
}
