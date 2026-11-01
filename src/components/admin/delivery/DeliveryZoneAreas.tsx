'use client';

import { useId, useState } from 'react';
import { addDeliveryZoneAreasAction, deliveryZoneAreasPageAction, removeDeliveryZoneAreaAction, type AreaView } from '@/server/domains/delivery/actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

interface Report {
  added: number;
  skipped: { words: string; reason: string }[];
  problems: { line: number; text: string; error: string }[];
}

/** The places of one zone: a page at a time, one added by hand or many pasted, and each removable. */
export function DeliveryZoneAreas({ zoneId, zoneCode, isActive, may, onChanged }: { zoneId: string; zoneCode: string; isActive: boolean; may: boolean; onChanged: () => void }) {
  const uid = useId();
  const [county, setCounty] = useState('');
  const [town, setTown] = useState('');
  const [area, setArea] = useState('');
  const [lines, setLines] = useState('');
  const [many, setMany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [report, setReport] = useState<Report | null>(null);
  const addWords = many ? 'Add these places' : 'Add place';
  const list = usePagedList<AreaView, Record<string, never>>({ load: (_f, cursor) => deliveryZoneAreasPageAction(zoneId, cursor), filters: {} });

  const add = async () => {
    setBusy(true);
    setNotice(null);
    setReport(null);
    const res = await attempt(addDeliveryZoneAreasAction(zoneId, many ? { lines } : { county, town, area }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const { added, skipped, problems } = res.data;
    setReport({ added, skipped, problems });
    setNotice({ kind: added > 0 ? 'ok' : 'error', text: added > 0 ? `Added ${String(added)} place${added === 1 ? '' : 's'} to ${zoneCode}.` : 'Nothing was added.' });
    if (added > 0) {
      setCounty('');
      setTown('');
      setArea('');
      setLines('');
      list.reload();
      onChanged();
    }
  };
  const remove = async (a: AreaView) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(removeDeliveryZoneAreaAction(a.id));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: `${a.words} removed from ${zoneCode}.` } : { kind: 'error', text: res.error });
    if (res.ok) {
      list.reload();
      onChanged();
    }
  };

  return (
    <section className="mt-3 space-y-3 border-t border-line pt-3" aria-label={`Places in ${zoneCode}`}>
      <Message notice={notice} />
      {may && isActive ? (
        <form
          className="space-y-3"
          aria-label={`Add places to ${zoneCode}`}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          {many ? (
            <Field id={`${uid}-lines`} label="Places, one on each line" hint="Write county, town, area, separated by commas. Leave a part empty to skip it, for example “, Kilimani”. Up to 200 lines.">
              <textarea id={`${uid}-lines`} value={lines} onChange={(e) => setLines(e.target.value)} rows={6} className={`${fieldClass} font-mono`} placeholder={'Nairobi, Westlands\nNairobi, , Kilimani\nMombasa'} />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id={`${uid}-county`} label="County">
                <input id={`${uid}-county`} value={county} onChange={(e) => setCounty(e.target.value)} className={fieldClass} placeholder="Nairobi" autoComplete="off" maxLength={80} />
              </Field>
              <Field id={`${uid}-town`} label="Town">
                <input id={`${uid}-town`} value={town} onChange={(e) => setTown(e.target.value)} className={fieldClass} placeholder="Westlands" autoComplete="off" maxLength={80} />
              </Field>
              <Field id={`${uid}-area`} label="Estate or area">
                <input id={`${uid}-area`} value={area} onChange={(e) => setArea(e.target.value)} className={fieldClass} placeholder="Sarit Centre" autoComplete="off" maxLength={80} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? 'Adding…' : addWords}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setMany((m) => !m)}>
              {many ? 'Add one place' : 'Add many at once'}
            </button>
          </div>
        </form>
      ) : null}
      {may && !isActive ? <p className="text-xs text-fg-muted">This zone is stopped. Restart it to add places.</p> : null}

      {report !== null && (report.skipped.length > 0 || report.problems.length > 0) ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-fg" role="status">
          <p className="font-semibold">Not added:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {report.skipped.map((s) => (
              <li key={s.words}>
                {s.words}: {s.reason}
              </li>
            ))}
            {report.problems.map((p) => (
              <li key={p.line}>
                Line {String(p.line)} ({p.text}): {p.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {list.phase === 'loading' ? (
        <p role="status" className="text-xs text-fg-muted">
          Loading places…
        </p>
      ) : null}
      {list.phase === 'error' ? (
        <p role="alert" className="text-xs text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      <ul className="grid gap-1.5 sm:grid-cols-2" aria-label={`Places in ${zoneCode}`}>
        {list.rows.map((a) => (
          <li key={a.id} className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-fg">
            <span className="min-w-0 break-words">{a.words}</span>
            {may ? <InlineConfirm label={`Remove ${a.words}`} action="Remove" confirm="Yes, remove" busy={busy} onConfirm={() => void remove(a)} /> : null}
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-xs text-fg-muted">No places yet. A written address reaches this zone through the places you add here.</p> : null}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more places'}
        </button>
      ) : null}
    </section>
  );
}
