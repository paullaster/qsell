'use client';

import { useId, useState } from 'react';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { nextKey, type RateLine } from '@/lib/charge-policy-form';
import { MAX_PASTED_FEES, parseRateCardPaste, type PastedRateCard } from '@/lib/rate-card-paste';
import { matchZoneCodesAction } from '@/server/domains/delivery/policy-actions';
import type { ChargeMethod } from '@/server/domains/delivery/domain/types';

type Mode = 'replace' | 'add';
const MODES = [
  { value: 'replace', label: 'Replace the fees' },
  { value: 'add', label: 'Add to the fees' },
] as const;

interface Read {
  card: PastedRateCard;
  zones: Map<string, { id: string; name: string }>;
  stopped: string[];
  unknown: string[];
}

const PROBLEMS_SHOWN = 8;

/**
 * Pastes a whole rate card from a spreadsheet instead of typing it a row at a time. Nothing is changed until the text has been
 * read with no problems and every zone code has been matched; a line with a mistake is named, never skipped quietly.
 */
export function ChargeRatePaste({ method, rates, onChange }: { method: ChargeMethod; rates: RateLine[]; onChange: (next: RateLine[]) => void }) {
  const uid = useId();
  const byZone = method === 'zone_rate';
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('replace');
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const reset = () => {
    setText('');
    setRead(null);
    setNotice(null);
  };

  const readIt = async () => {
    setBusy(true);
    setNotice(null);
    const card = parseRateCardPaste(text, byZone);
    let zones = new Map<string, { id: string; name: string }>();
    let stopped: string[] = [];
    let unknown: string[] = [];
    if (card.zoneCodes.length > 0) {
      const res = await attempt(matchZoneCodesAction(card.zoneCodes));
      if (!res.ok) {
        setBusy(false);
        setRead(null);
        setNotice({ kind: 'error', text: res.error });
        return;
      }
      zones = new Map(res.data.zones.map((z) => [z.code, { id: z.id, name: z.name }]));
      stopped = res.data.stopped;
      unknown = res.data.unknown;
    }
    setBusy(false);
    setRead({ card, zones, stopped, unknown });
    if (card.fees.length === 0 && card.problems.length === 0) setNotice({ kind: 'error', text: 'There is nothing to read yet. Paste the fees, one to a line.' });
  };

  const ready = read !== null && read.card.fees.length > 0 && read.card.problems.length === 0 && read.stopped.length === 0 && read.unknown.length === 0 && !read.card.truncated;

  const apply = () => {
    if (read === null || !ready) return;
    const base = mode === 'replace' ? [] : rates;
    let key = Number(nextKey(base));
    const added: RateLine[] = read.card.fees.map((f) => {
      const zone = f.zoneCode === null ? null : (read.zones.get(f.zoneCode) ?? null);
      const line: RateLine = { key: String(key), zone: zone === null || f.zoneCode === null ? null : { id: zone.id, label: `${zone.name} (${f.zoneCode})` }, fromKg: f.fromKg, toKg: f.toKg, fee: f.fee, perExtraKg: f.perExtraKg };
      key += 1;
      return line;
    });
    onChange([...base, ...added]);
    const count = `${String(added.length)} fee${added.length === 1 ? '' : 's'}`;
    setNotice({ kind: 'ok', text: `${mode === 'replace' ? `The card now has ${count}` : `Added ${count}`}. Check them below, then save the draft.` });
    setText('');
    setRead(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="space-y-1">
        <button type="button" className={buttonClass} onClick={() => setOpen(true)}>
          Paste a rate card
        </button>
        <Message notice={notice} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" role="group" aria-label="Paste a rate card">
      <p className="text-xs text-fg-muted">
        {byZone ? 'One fee to a line: zone code, from kg, up to kg, fee, each extra kg. ' : 'One fee to a line: from kg, up to kg, fee, each extra kg. '}
        Copy the rows from a spreadsheet, or separate the columns with a semicolon or a comma.
        {byZone ? ' A zone of * is the fee for any other zone.' : ''} Leave &ldquo;up to kg&rdquo; empty for no limit. Up to {String(MAX_PASTED_FEES)} fees at once.
      </p>
      <label htmlFor={`${uid}-text`} className="sr-only">
        Rate card
      </label>
      <textarea
        id={`${uid}-text`}
        className={`${fieldClass} min-h-40 font-mono text-xs`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setRead(null);
          setNotice(null);
        }}
        placeholder={byZone ? 'NBO-CBD\t0\t5\t250\nNBO-CBD\t5\t\t350\t40\n*\t0\t\t900' : '0\t5\t200\n5\t\t350\t20'}
        spellCheck={false}
        autoComplete="off"
      />
      <SegmentedChoice label="What to do with the fees on the card now" value={mode} options={MODES} onChange={setMode} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void readIt()}>
          {busy ? 'Reading…' : 'Read it'}
        </button>
        <button type="button" className={primaryClass} disabled={!ready} onClick={apply}>
          {read !== null && ready ? `Use these ${String(read.card.fees.length)} fees` : 'Use these fees'}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
      <Message notice={notice} />
      {read === null ? null : <Findings read={read} />}
    </div>
  );
}

function Findings({ read }: { read: Read }) {
  const { card, stopped, unknown } = read;
  const bad = card.problems.length;
  return (
    <div className="space-y-2 text-sm" aria-live="polite">
      <p className="text-fg">
        {String(card.fees.length)} fee{card.fees.length === 1 ? '' : 's'} read{bad > 0 ? `, ${String(bad)} line${bad === 1 ? '' : 's'} with a mistake` : ''}.
      </p>
      {card.truncated ? <p className="text-red-700">There are more than {String(MAX_PASTED_FEES)} lines. Paste them in parts.</p> : null}
      {unknown.length > 0 ? <p className="text-red-700">No zone has the code {unknown.join(', ')}. Check the codes under Delivery zones.</p> : null}
      {stopped.length > 0 ? <p className="text-red-700">The zone {stopped.join(', ')} is stopped. Start it again before giving it fees.</p> : null}
      {bad > 0 ? (
        <ul className="space-y-1 text-red-700" aria-label="Lines with a mistake">
          {card.problems.slice(0, PROBLEMS_SHOWN).map((p) => (
            <li key={p.line} className="break-words">
              Line {String(p.line)}: {p.message} <span className="text-fg-muted">({p.text})</span>
            </li>
          ))}
          {bad > PROBLEMS_SHOWN ? <li>…and {String(bad - PROBLEMS_SHOWN)} more.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
