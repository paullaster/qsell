'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { inviteColleagueAction, removeTeamMemberAction, resendInvitationAction, type teamAction } from '@/server/domains/vendors/portal-team-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Team = Extract<Awaited<ReturnType<typeof teamAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string; problems?: Record<string, string> };

const messageOf = (data: unknown): string | null => (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string' ? data.message : null);

const ROLE_WORDS: Record<string, string> = { owner: 'Owner', finance: 'Finance', sales: 'Sales', readonly: 'Read-only' };

export function TeamClient({ teamPromise }: { teamPromise: ReturnType<typeof teamAction> }) {
  const res = use(teamPromise);
  return res.ok ? <TeamView team={res.data} /> : <LoadFailed error={res.error} />;
}

function TeamView({ team }: { team: Team }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', email: '' });
  const [role, setRole] = useState<Choice | null>({ id: 'sales', label: 'Sales' });

  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setProblems({});
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblems('problems' in res && res.problems !== undefined ? res.problems : {});
      return false;
    }
    setNotice({ kind: 'ok', text: messageOf(res.data) ?? done });
    router.refresh();
    return true;
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Your team" intro="The people who can sign in for your business. Each role sees and changes only its own parts of the profile." actions={<Link href="/vendor" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      <section aria-label="People" className={cardClass}>
        <ul className="divide-y divide-line text-sm">
          {team.people.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 break-words"><span className="font-semibold text-fg-strong">{p.name}</span> <span className="text-fg-muted">{p.email}</span></span>
              <span className="flex flex-wrap items-center gap-2">
                <Chip tone="gray">{ROLE_WORDS[p.role] ?? p.role}</Chip>
                {p.id === team.you ? <Chip tone="sky">You</Chip> : null}
                {p.joined ? null : <Chip tone="amber">Invited, not joined</Chip>}
                {team.canManage && p.role !== 'owner' ? (
                  <>
                    {p.joined ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(resendInvitationAction(p.id), 'A fresh invitation was sent.')} aria-label={`Resend the invitation to ${p.email}`}>Resend</button>}
                    <InlineConfirm label={`Remove ${p.name} from your team`} action="Remove" confirm="Yes, remove" busy={busy} onConfirm={() => void act(removeTeamMemberAction(p.id), 'Removed.')} />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {team.canManage ? (
        <form
          className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2`}
          aria-label="Invite a colleague"
          noValidate
          onSubmit={(e) => { e.preventDefault(); void act(inviteColleagueAction({ ...form, role: role?.id ?? '' }), 'Invitation sent.').then((ok) => { if (ok) setForm({ name: '', email: '' }); }); }}
        >
          <h2 className="text-sm font-bold text-fg-strong sm:col-span-2">Invite a colleague</h2>
          <Field id={`${uid}-n`} label="Name" hint={problems.name}><input id={`${uid}-n`} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className={fieldClass} required maxLength={120} autoComplete="off" aria-invalid={problems.name !== undefined} /></Field>
          <Field id={`${uid}-e`} label="Email" hint={problems.email ?? 'They get a link to choose a password. It works for 7 days.'}><input id={`${uid}-e`} type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} className={fieldClass} required maxLength={160} autoComplete="off" aria-invalid={problems.email !== undefined} /></Field>
          <ChoicePicker label="Role" source="vendor-portal-roles" choice={role} onChoice={setRole} clearable={false} required />
          <div className="flex items-end"><button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button></div>
        </form>
      ) : <p className="text-sm text-fg-muted">Only the owner of the account can invite or remove people.</p>}
    </div>
  );
}
