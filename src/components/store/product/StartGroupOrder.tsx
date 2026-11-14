'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';
import { createGroupAction } from '@/server/domains/pricing/package-group-actions';
import { MAX_GROUP_TITLE } from '@/lib/group-order';
import { useStore } from '@/components/store/StoreContext';

/** For a signed-in shopper: start a group order for this package, where each person chooses their own serving and the shopper pays once. */
export function StartGroupOrder({ productId }: { productId: string }) {
  const { sessionName } = useStore();
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [forDate, setForDate] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (sessionName === null) {
    return <p className="text-sm text-fg-muted"><Link href={`/login?callbackUrl=${encodeURIComponent(`/product/${productId}`)}`} className="font-semibold text-indigo-500 hover:underline">Sign in</Link> to order for a group: each person chooses their own, and you pay once.</p>;
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-1 text-sm font-semibold text-indigo-500 hover:underline">
        <Users className="h-4 w-4" aria-hidden="true" />Order for a group
      </button>
    );
  }
  const start = async () => {
    setBusy(true);
    setProblem(null);
    const r = await createGroupAction({ productId, title, forDate: forDate === '' ? null : forDate, closesAt: closesAt === '' ? null : new Date(closesAt).toISOString() }).catch(() => null);
    setBusy(false);
    if (r === null) setProblem('The shop could not be reached. Please try again.');
    else if (!r.ok) setProblem(r.error);
    else router.push(`/group/${r.data.token}`);
  };
  return (
    <form
      aria-label="Start a group order"
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h3 className="text-sm font-semibold text-fg-strong">Order for a group</h3>
      <p className="text-xs text-fg-muted">You get a link to share. Each person opens it and chooses their own. You see everyone&apos;s choices, put them in your cart and pay once.</p>
      <div className="space-y-1">
        <label htmlFor={`${uid}-t`} className="text-sm font-medium text-fg-muted">What is it for (optional)</label>
        <input id={`${uid}-t`} value={title} maxLength={MAX_GROUP_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="Friday team lunch" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${uid}-d`} className="text-sm font-medium text-fg-muted">Needed on (optional)</label>
          <input id={`${uid}-d`} type="date" value={forDate} onChange={(e) => setForDate(e.target.value)} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong" />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${uid}-c`} className="text-sm font-medium text-fg-muted">Choose before (optional)</label>
          <input id={`${uid}-c`} type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong" />
        </div>
      </div>
      {problem === null ? null : <p role="alert" className="text-sm text-red-400">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">Start the group order</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-11 cursor-pointer rounded-lg px-3 text-sm font-medium text-fg-muted hover:bg-hover">Not now</button>
      </div>
    </form>
  );
}
