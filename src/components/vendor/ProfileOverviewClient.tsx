'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type profileOverviewAction, submitProfileAction } from '@/server/domains/vendors/profile-actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { SectionStatus } from '@/lib/vendor-profile';

const TONE = { not_started: 'gray', draft: 'amber', complete: 'green' } as const;
const WORDS: Record<SectionStatus, string> = { not_started: 'Not started', draft: 'In progress', complete: 'Complete' };

const BANNER: Record<string, string> = {
  registered: 'Fill in the five sections below, then send your profile for review.',
  profile_in_progress: 'Fill in the five sections below, then send your profile for review.',
  profile_submitted: 'Your profile has been sent. We will look at it soon. You will not be able to change it while it is being reviewed.',
  under_review: 'Your profile is being reviewed. You will not be able to change it until we decide.',
  revision_requested: 'We asked for changes. Fix what is marked below, then send your profile again.',
  active: 'Your profile is approved. You can keep your contact persons and documents up to date here.',
  suspended: 'Your account is suspended. You can keep your contact persons and documents up to date.',
  rejected: 'Your application was not accepted.',
};

export function ProfileOverviewClient({ overviewPromise }: { overviewPromise: ReturnType<typeof profileOverviewAction> }) {
  const res = use(overviewPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <Overview view={res.data} />;
}

function Overview({ view }: { view: Extract<Awaited<ReturnType<typeof profileOverviewAction>>, { ok: true }>['data'] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const showWhy = !view.canSubmit && view.submitBlockedBecause !== null && (view.status === 'registered' || view.status === 'profile_in_progress' || view.status === 'revision_requested');
  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(submitProfileAction());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Your profile has been sent for review.' });
    router.refresh();
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Your profile" intro={BANNER[view.status] ?? ''} />
      <Message notice={notice} />
      <ol className={`${cardClass} divide-y divide-line`} aria-label="Profile sections">
        {view.sections.map((s) => (
          <li key={s.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/vendor/profile/${s.id}`} className="text-sm font-bold text-indigo-600 hover:underline">{s.label}</Link>
                <p className="text-xs text-fg-muted">{s.hint}</p>
              </div>
              <Chip tone={TONE[s.status]}>{WORDS[s.status]}</Chip>
            </div>
            {s.note === null ? null : <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-fg"><span className="font-semibold">To fix:</span> {s.note}</p>}
            {s.status === 'complete' || !s.canEdit ? null : (
              <ul className="list-disc pl-5 text-xs text-fg-muted">{s.missing.slice(0, 4).map((m) => <li key={m}>{m}</li>)}</ul>
            )}
          </li>
        ))}
      </ol>
      {view.canSubmit ? (
        <div className="space-y-2">
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send my profile for review'}</button>
          <p className="text-xs text-fg-muted">After you send it, you cannot change it until we decide.</p>
        </div>
      ) : null}
      {showWhy ? <p className="text-xs text-fg-muted">{view.submitBlockedBecause}</p> : null}
    </div>
  );
}
