'use client';

import { use, useId, useState } from 'react';
import { X } from 'lucide-react';
import { resetEmailRouteAction, saveEmailRouteAction, type emailRoutingScreenAction } from '@/server/domains/email-routing/actions';
import type { LabelledSource, PointView } from '@/server/domains/email-routing/email-route-service';
import type { ListName } from '@/server/domains/email-routing/email-routes';
import { SourceAdder } from './SourceAdder';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof emailRoutingScreenAction>>;

const LISTS: { name: ListName; title: string; hint: string }[] = [
  { name: 'to', title: 'Sent to', hint: 'Who the email is written to. You can add several people.' },
  { name: 'cc', title: 'Copied (Cc)', hint: 'Seen by everyone on the email.' },
  { name: 'bcc', title: 'Blind-copied (Bcc)', hint: 'Gets the email without being shown to the others.' },
  { name: 'replyTo', title: 'Replies go to (Reply-To)', hint: 'When the customer presses Reply, it goes to these addresses. Leave empty to reply to the sender.' },
];

export function EmailRoutingClient({ firstPromise }: { firstPromise: ReturnType<typeof emailRoutingScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: PointView[] }) {
  const [points, setPoints] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const mails = points.filter((p) => p.kind === 'mail');
  const documents = points.filter((p) => p.kind === 'document');
  const card = (p: PointView) => (
    <li key={p.key} className={cardClass}>
      {editing === p.key ? (
        <Editor
          point={p}
          onCancel={() => setEditing(null)}
          onSaved={(next, text) => {
            setPoints(next);
            setEditing(null);
            setNotice({ kind: 'ok', text });
          }}
        />
      ) : (
        <Summary point={p} onChange={() => { setNotice(null); setEditing(p.key); }} />
      )}
    </li>
  );
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Email routing" intro="Choose who receives each business email, who is copied, where customers' replies go, and which business emails a quote shows. Until you change one, it works as it always has." />
      <Message notice={notice} />
      <section aria-labelledby="mails" className="space-y-3">
        <h2 id="mails" className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Emails</h2>
        <ul className="space-y-3">{mails.map(card)}</ul>
      </section>
      <section aria-labelledby="docs" className="space-y-3">
        <h2 id="docs" className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Business emails shown on quotes</h2>
        <ul className="space-y-3">{documents.map(card)}</ul>
      </section>
    </div>
  );
}

function words(list: LabelledSource[]): string {
  return list.map((s) => s.label).join(', ');
}

function Summary({ point, onChange }: { point: PointView; onChange: () => void }) {
  const problems = LISTS.concat([{ name: 'shown', title: '', hint: '' }]).flatMap((l) => point.lists[l.name].filter((s) => s.problem !== null));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-fg-strong">{point.label}</h3>
          <p className="text-xs text-fg-muted">{point.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {point.kind === 'mail' ? <Chip tone={point.enabled ? 'green' : 'gray'}>{point.enabled ? 'On' : 'Off'}</Chip> : null}
          <Chip tone={point.configured ? 'sky' : 'gray'}>{point.configured ? 'Changed' : 'As built in'}</Chip>
          <button type="button" className={buttonClass} aria-label={`Change ${point.label}`} onClick={onChange}>Change</button>
        </div>
      </div>
      {point.kind === 'mail' ? (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          {LISTS.map((l) => (point.lists[l.name].length === 0 ? null : <div key={l.name} className="contents"><dt className="text-fg-muted">{l.title}</dt><dd className="min-w-0 break-words text-fg">{words(point.lists[l.name])}</dd></div>))}
          {!point.enabled && point.lists.to.length === 0 ? <div className="contents"><dt className="text-fg-muted">Sent to</dt><dd className="text-fg-muted">Nobody: this email is not sent.</dd></div> : null}
        </dl>
      ) : (
        <p className="text-sm text-fg">Shown: {point.lists.shown.length === 0 ? 'the company email (nothing chosen)' : words(point.lists.shown)}</p>
      )}
      {problems.length === 0 ? null : <ul className="space-y-1" aria-label="Things to fix">{problems.map((s) => <li key={`${s.label}-${s.problem ?? ''}`} className="text-xs text-amber-700">{s.label}: {s.problem}</li>)}</ul>}
    </div>
  );
}

function Editor({ point, onCancel, onSaved }: { point: PointView; onCancel: () => void; onSaved: (points: PointView[], text: string) => void }) {
  const uid = useId();
  const [enabled, setEnabled] = useState(point.enabled);
  const [lists, setLists] = useState(point.lists);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const visible = point.kind === 'mail' ? LISTS : [{ name: 'shown' as ListName, title: 'Shown on the quote', hint: 'The "Questions? Contact …" emails the customer sees on the quote, on the public quote page and in the quote email. Leave empty to show the company email.' }];
  const add = (name: ListName, next: LabelledSource) =>
    setLists((current) => {
      const key = JSON.stringify(next.source);
      return current[name].some((s) => JSON.stringify(s.source) === key) ? current : { ...current, [name]: [...current[name], next] };
    });
  const remove = (name: ListName, index: number) => setLists((current) => ({ ...current, [name]: current[name].filter((_, i) => i !== index) }));
  const payload = () => ({ enabled, ...Object.fromEntries((['to', 'cc', 'bcc', 'replyTo', 'shown'] as const).map((n) => [n, lists[n].map((s) => s.source)])) });
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(saveEmailRouteAction(point.key, payload(), reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, 'Saved. It applies to the next email.');
    else setProblem(r.error);
  };
  const reset = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(resetEmailRouteAction(point.key, reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, 'Put back to how it was built in.');
    else setProblem(r.error);
  };
  return (
    <form
      aria-label={`Change ${point.label}`}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-sm font-bold text-fg-strong">{point.label}</h3>
        <p className="text-xs text-fg-muted">{point.description}</p>
      </div>
      {point.kind === 'mail' ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Send this email
        </label>
      ) : null}
      {visible.map((l) => (
        <fieldset key={l.name} className="space-y-2 rounded-lg border border-line p-3" disabled={point.kind === 'mail' && !enabled}>
          <legend className="px-1 text-xs font-bold tracking-wider text-fg-subtle uppercase">{l.title}</legend>
          <p className="text-xs text-fg-muted">{l.hint}</p>
          {lists[l.name].length === 0 ? <p className="text-sm text-fg-muted">Nobody yet.</p> : (
            <ul className="flex flex-wrap gap-2" aria-label={l.title}>
              {lists[l.name].map((s, i) => (
                <li key={JSON.stringify(s.source)} className="flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-3 text-sm">
                  <span className="break-all">{s.label}{s.address !== null && s.address !== s.label ? ` <${s.address}>` : ''}</span>
                  <button type="button" className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-hover" aria-label={`Remove ${s.label} from ${l.title}`} onClick={() => remove(l.name, i)}><X className="size-4" aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          <SourceAdder idBase={`${uid}-${l.name}`} title={l.title} onAdd={(next) => add(l.name, next)} />
        </fieldset>
      ))}
      <ReasonField value={reason} onChange={setReason} source="email-routing-reasons" />
      <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryClass} disabled={busy || reason.code === ''}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {point.configured ? <InlineConfirm label={`Put ${point.label} back to how it was built in`} action="Put back as built in" confirm="Yes, put it back" busy={busy || reason.code === ''} onConfirm={() => void reset()} /> : null}
      </div>
      {reason.code === '' ? <p className="text-xs text-fg-muted">Choose a reason to save.</p> : null}
    </form>
  );
}
