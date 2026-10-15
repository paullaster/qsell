import type { SeriesDetailView } from '@/server/kernel/numbering/actions';
import { cardClass } from '@/components/ui/screen-kit';
import { has } from '@/lib/values';

const ACTION_LABEL: Record<string, string> = {
  'numbering.series_created': 'Series created',
  'numbering.series_updated': 'Series changed',
  'numbering.series_deleted': 'Series deleted',
  'numbering.line_added': 'Line added',
  'numbering.line_updated': 'Line changed',
  'numbering.line_closed': 'Line closed',
  'numbering.line_opened': 'Line reopened',
  'numbering.binding_set': 'Document linked',
  'numbering.binding_cleared': 'Document unlinked',
  'numbering.near_end': 'Near the end of its range',
};

/** What was issued lately. Only displays what it is given. */
export function SeriesRecent({ recent }: { recent: SeriesDetailView['recent'] }) {
  return (
    <section className={`${cardClass} space-y-4`} aria-label="Recent numbers">
      <h3 className="text-base font-bold text-fg-strong">Recently issued</h3>
      {recent.length === 0 ? (
        <p className="text-sm text-fg-muted">No numbers issued yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <caption className="sr-only">Most recent numbers issued by this series</caption>
            <thead className="border-b border-line text-fg-muted uppercase">
              <tr>
                <th scope="col" className="px-2 py-2">Number</th>
                <th scope="col" className="px-2 py-2">Document</th>
                <th scope="col" className="px-2 py-2">Document date</th>
                <th scope="col" className="px-2 py-2">Issued</th>
                <th scope="col" className="px-2 py-2">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {recent.map((r) => (
                <tr key={r.number}>
                  <td className="px-2 py-2 font-mono font-semibold text-fg-strong">{r.number}</td>
                  <td className="px-2 py-2 text-fg">{has(r.documentKind) ? `${r.documentKind} ${r.documentId ?? ''}` : '—'}</td>
                  <td className="px-2 py-2 text-fg">{r.documentDate}</td>
                  <td className="px-2 py-2 text-fg-muted">{new Date(r.allocatedAt).toLocaleString()}</td>
                  <td className="px-2 py-2 text-fg-muted">{r.source === 'manual' ? 'Typed in' : 'Automatic'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Every change to the series, who made it and why. Only displays what it is given. */
export function SeriesHistory({ history }: { history: SeriesDetailView['history'] }) {
  return (
    <section className={`${cardClass} space-y-4`} aria-label="History">
      <h3 className="text-base font-bold text-fg-strong">History</h3>
      <p className="text-xs text-fg-muted">Every change to this series, who made it and why. This record cannot be edited.</p>
      {history.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {history.map((h, i) => (
            <li key={`${h.at}-${String(i)}`} className="text-xs">
              <p className="font-semibold text-fg-strong">
                {ACTION_LABEL[h.action] ?? h.action}{' '}
                <span className="font-normal text-fg-muted">
                  · {new Date(h.at).toLocaleString()} · {h.actor ?? 'system'}
                </span>
              </p>
              {has(h.reasonCode) ? (
                <p className="text-fg-muted">
                  Reason: {h.reasonCode}
                  {has(h.reasonText) ? ` — ${h.reasonText}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
