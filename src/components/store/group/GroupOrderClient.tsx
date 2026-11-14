'use client';

import { Suspense, use, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { addGroupEntryAction, groupToCartAction, groupViewAction, removeGroupEntryAction, setGroupStatusAction, updateGroupEntryAction } from '@/server/domains/pricing/package-group-actions';
import type { GroupView } from '@/server/domains/pricing/package-group-service';
import { MAX_PERSON_NAME } from '@/lib/group-order';
import { packageLine, type PackagePick } from '@/lib/package-cart';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { PackageBuilder } from '@/components/store/product/PackageBuilder';
import { InlineConfirm } from '@/components/ui/InlineConfirm';

const saved = (token: string) => `qsell_group_${token}`;

interface MyEntry {
  entryId: string;
  secret: string;
  name: string;
  picks: PackagePick[];
  note: string;
}

/** What this browser remembers of the person's own choice in this group (so they can change or withdraw it). */
function readMine(token: string): MyEntry | null {
  try {
    const raw = window.localStorage.getItem(saved(token));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<MyEntry>;
    return typeof value.entryId === 'string' && typeof value.secret === 'string' && typeof value.name === 'string' && Array.isArray(value.picks) ? { entryId: value.entryId, secret: value.secret, name: value.name, picks: value.picks, note: typeof value.note === 'string' ? value.note : '' } : null;
  } catch {
    return null;
  }
}
const keepMine = (token: string, entry: MyEntry | null): void => {
  try {
    if (entry === null) window.localStorage.removeItem(saved(token));
    else window.localStorage.setItem(saved(token), JSON.stringify(entry));
  } catch {
    /* a browser that keeps nothing still lets the person choose; they just cannot change it later from here */
  }
};

export function GroupOrderClient({ token, viewPromise }: { token: string; viewPromise: ReturnType<typeof groupViewAction> }) {
  return (
    <Suspense fallback={<p role="status" className="text-sm text-fg-muted">Opening the group order…</p>}>
      <Loaded token={token} viewPromise={viewPromise} />
    </Suspense>
  );
}

function Loaded({ token, viewPromise }: { token: string; viewPromise: ReturnType<typeof groupViewAction> }) {
  const res = use(viewPromise);
  if (!res.ok) return <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{res.error}</p>;
  if (res.data === null) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-bold text-fg-strong">This group order was not found</h1>
        <p className="text-sm text-fg-muted">The link may be wrong or the group order may have been removed. Ask the person who shared it for the link again.</p>
      </div>
    );
  }
  return <Body token={token} initial={res.data} />;
}

function Body({ token, initial }: { token: string; initial: GroupView }) {
  const [view, setView] = useState(initial);
  const reload = async () => {
    const r = await groupViewAction(token).catch(() => null);
    if (r?.ok === true && r.data !== null) setView(r.data);
  };
  const when = view.closesAt === null ? null : new Date(view.closesAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm font-semibold tracking-wide text-indigo-500 uppercase">Group order</p>
        <h1 className="text-2xl font-bold text-fg-strong">{view.title === '' ? `${view.packageName} for the group` : view.title}</h1>
        <p className="text-sm text-fg-muted">
          {view.organiserName} is ordering {view.packageName}
          {view.forDate === null ? '' : ` for ${new Date(`${view.forDate}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}`}
          . {view.entryCount} {view.entryCount === 1 ? 'person has' : 'people have'} chosen so far.
          {when === null ? '' : ` Choose before ${when}.`}
        </p>
      </header>
      {view.closedReason === null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">{view.closedReason}</p>}
      {view.isOrganiser ? <Organiser token={token} view={view} onChanged={reload} /> : null}
      {view.accepts && view.builder !== null ? <Choose token={token} view={view} onChanged={reload} /> : null}
    </div>
  );
}

/** A person chooses their own serving. */
function Choose({ token, view, onChanged }: { token: string; view: GroupView; onChanged: () => Promise<void> }) {
  const { money } = useStore();
  const uid = useId();
  const [mine, setMine] = useState<MyEntry | null>(null);
  const [name, setName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Read after the page is drawn: what this browser kept exists only here.
    const start = async () => {
      await Promise.resolve();
      const kept = readMine(token);
      setMine(kept);
      setName(kept?.name ?? '');
      setReady(true);
    };
    void start();
  }, [token]);

  if (view.builder === null) return null;
  if (!ready) return <p role="status" className="text-sm text-fg-muted">Opening your choice…</p>;
  const builder = view.builder;
  return (
    <section aria-labelledby={`${uid}-choose`} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h2 id={`${uid}-choose`} className="text-lg font-bold text-fg-strong">{mine === null ? 'Choose your own' : 'Your choice'}</h2>
      {mine === null ? <p className="text-sm text-fg-muted">Everyone chooses their own serving. {view.organiserName} pays once for all of you.</p> : <p className="text-sm text-fg-muted">You have chosen. You can change it until the group closes.</p>}
      <div className="space-y-1">
        <label htmlFor={`${uid}-name`} className="text-sm font-medium text-fg-muted">Your name</label>
        <input id={`${uid}-name`} value={name} maxLength={MAX_PERSON_NAME} onChange={(e) => setName(e.target.value)} autoComplete="name" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong" />
      </div>
      <PackageBuilder
        key={mine?.entryId ?? 'new'}
        productName={builder.package.name}
        builder={builder}
        money={money}
        fixedServings
        noteLabel="Anything the kitchen should know (optional)"
        submitLabel={mine === null ? 'Save my choice' : 'Change my choice'}
        {...(mine === null ? {} : { initial: { picks: mine.picks, servings: 1, note: mine.note } })}
        onSubmit={async (picks, _servings, _intent, note) => {
          setProblem(null);
          const payload = { name, picks, note };
          if (mine === null) {
            const r = await addGroupEntryAction(token, payload);
            if (!r.ok) return r.error;
            const next: MyEntry = { entryId: r.data.entryId, secret: r.data.secret, name, picks, note };
            keepMine(token, next);
            setMine(next);
          } else {
            const r = await updateGroupEntryAction(token, mine.entryId, mine.secret, payload);
            if (!r.ok) return r.error;
            const next: MyEntry = { ...mine, name, picks, note };
            keepMine(token, next);
            setMine(next);
          }
          setDone(mine === null ? 'Your choice is saved.' : 'Your choice is changed.');
          await onChanged();
          return null;
        }}
      />
      {done === null ? null : <p role="status" className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{done}</p>}
      {problem === null ? null : <p role="alert" className="text-sm text-red-400">{problem}</p>}
      {mine === null ? null : (
        <InlineConfirm
          label="Withdraw my choice"
          action="Withdraw my choice"
          confirm="Yes, withdraw it"
          onConfirm={() => {
            void removeGroupEntryAction(token, mine.entryId, mine.secret).then(async (r) => {
              if (!r.ok) setProblem(r.error);
              else {
                keepMine(token, null);
                setMine(null);
                setDone('Your choice is withdrawn.');
                await onChanged();
              }
            });
          }}
        />
      )}
    </section>
  );
}

/** The organiser: the link to share, who chose what, and putting everyone's lunches in their cart. */
function Organiser({ token, view, onChanged }: { token: string; view: GroupView; onChanged: () => Promise<void> }) {
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; problems?: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? `/group/${token}` : `${window.location.origin}/group/${token}`;

  const act = async (call: Promise<{ ok: boolean; error?: string }>, ok: string) => {
    setBusy(true);
    setNotice(null);
    const r = await call.catch(() => ({ ok: false, error: 'The shop could not be reached. Please try again.' }));
    setBusy(false);
    if (!r.ok) setNotice({ tone: 'error', text: r.error ?? 'Something went wrong.' });
    else {
      setNotice({ tone: 'ok', text: ok });
      await onChanged();
    }
  };

  const toCart = async () => {
    setBusy(true);
    setNotice(null);
    const r = await groupToCartAction(token).catch(() => null);
    if (r?.ok !== true) {
      setBusy(false);
      setNotice({ tone: 'error', text: r === null ? 'The shop could not be reached. Please try again.' : r.error });
      return;
    }
    const failed: string[] = r.data.problems.map((p) => `${p.person}: ${p.message}`);
    for (const line of r.data.lines) {
      const answer = await cart.addPackage(packageLine(view.productId, line.picks, line.servings, line.note));
      if (!answer.ok) failed.push(`${line.people.join(', ')}: ${answer.problems[0] ?? 'could not be added.'}`);
    }
    setBusy(false);
    setNotice({ tone: failed.length === 0 ? 'ok' : 'error', text: failed.length === 0 ? `Everyone's lunch is in your cart: ${String(view.entryCount)} servings. Check out to pay once.` : 'Some lunches could not be put in your cart:', problems: failed });
    await onChanged();
  };

  return (
    <section aria-label="Organiser" className="space-y-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 sm:p-5" data-testid="group-organiser">
      <h2 className="text-lg font-bold text-fg-strong">You are the organiser</h2>
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg-muted">Share this link with the people who are eating</p>
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly aria-label="Link to share" value={link} className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="min-h-11 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-4 text-sm font-semibold text-fg-strong hover:bg-hover" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">Who has chosen ({view.entryCount})</h3>
        {view.entries.length === 0 ? <p className="text-sm text-fg-muted">Nobody yet.</p> : null}
        <ul className="divide-y divide-line">
          {view.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm" data-testid="group-entry">
              <div className="min-w-0">
                <p className="font-semibold break-words text-fg-strong">{e.personName}</p>
                <p className="break-words text-fg-muted">{e.words}</p>
                {e.note === '' ? null : <p className="text-xs break-words text-amber-700 dark:text-amber-300">Note: {e.note}</p>}
              </div>
              <InlineConfirm label={`Remove ${e.personName}'s choice`} action="Remove" confirm="Yes, remove" busy={busy} onConfirm={() => void act(removeGroupEntryAction(token, e.id), `${e.personName}'s choice was removed.`)} />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || view.entryCount === 0 || view.status === 'cancelled'} onClick={() => void toCart()} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">Put everyone&apos;s lunch in my cart</button>
        {view.status === 'open' ? <button type="button" disabled={busy} onClick={() => void act(setGroupStatusAction(token, 'closed'), 'The group order is closed.')} className="min-h-11 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-4 text-sm font-semibold text-fg-strong hover:bg-hover disabled:opacity-50">Stop taking choices</button> : null}
        {view.status === 'closed' ? <button type="button" disabled={busy} onClick={() => void act(setGroupStatusAction(token, 'open'), 'The group order is open again.')} className="min-h-11 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-4 text-sm font-semibold text-fg-strong hover:bg-hover disabled:opacity-50">Take choices again</button> : null}
        {view.status === 'cancelled' ? null : <InlineConfirm label="Cancel this group order" action="Cancel group order" confirm="Yes, cancel it" busy={busy} onConfirm={() => void act(setGroupStatusAction(token, 'cancelled'), 'The group order was cancelled.')} />}
        {cart.packages.length === 0 ? null : <Link href="/checkout" className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-fg-strong hover:bg-hover">Go to checkout</Link>}
      </div>
      {notice === null ? null : (
        <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${notice.tone === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
          <p>{notice.text}</p>
          {(notice.problems ?? []).length === 0 ? null : <ul className="mt-1 list-disc pl-5">{(notice.problems ?? []).map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
