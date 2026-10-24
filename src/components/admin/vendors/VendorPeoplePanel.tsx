'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelVendorInvitationAction, inviteVendorOwnerAction, resendVendorInvitationAction } from '@/server/domains/vendors/admin-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, Message, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Result = { ok: true } | { ok: false; error: string };

export interface PortalPerson {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  joined: boolean;
}

/** The people who can sign in for a vendor, their invitations, and (for a vendor with no owner yet) the invitation of its owner. */
export function VendorPeoplePanel({ vendorId, people, canInvite, archived }: { vendorId: string; people: PortalPerson[]; canInvite: boolean; archived: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [who, setWho] = useState({ name: '', email: '' });
  const active = people.filter((p) => p.status === 'active');
  const hasOwner = active.some((p) => p.role === 'owner');

  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };

  return (
    <section aria-label="Portal users" className={cardClass}>
      <h3 className="text-sm font-bold text-fg-strong">People who can sign in</h3>
      <Message notice={notice} />
      {people.length === 0 ? <p className="mt-1 text-sm text-fg-muted">Nobody has a vendor portal login for this vendor yet.</p> : (
        <ul className="mt-2 divide-y divide-line text-sm">
          {people.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 break-words"><span className="font-semibold text-fg-strong">{u.name}</span> <span className="text-fg-muted">{u.email}</span></span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <Chip tone="gray">{u.role}</Chip>
                {u.status !== 'active' ? <Chip tone="amber">Removed</Chip> : null}
                {u.status === 'active' && !u.joined ? <Chip tone="sky">Invited, not joined</Chip> : null}
                {canInvite && u.status === 'active' && !u.joined ? (
                  <>
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(resendVendorInvitationAction(vendorId, u.id), 'A fresh invitation was sent.')} aria-label={`Resend the invitation to ${u.email}`}>Resend</button>
                    <InlineConfirm label={`Cancel the invitation to ${u.email}`} action="Cancel invitation" confirm="Yes, cancel it" busy={busy} onConfirm={() => void act(cancelVendorInvitationAction(vendorId, u.id), 'The invitation is cancelled.')} />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canInvite && !hasOwner && !archived ? (
        <form
          className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-2"
          aria-label="Invite the owner"
          onSubmit={(e) => { e.preventDefault(); void act(inviteVendorOwnerAction(vendorId, who), 'The invitation was sent.').then((ok) => { if (ok) setWho({ name: '', email: '' }); }); }}
        >
          <p className="text-sm text-fg sm:col-span-2">This vendor has no owner who can sign in. Invite one: they receive a link to choose a password.</p>
          <Field id={`${uid}-n`} label="Owner’s name"><input id={`${uid}-n`} value={who.name} onChange={(e) => setWho((p) => ({ ...p, name: e.target.value }))} className={fieldClass} required maxLength={120} autoComplete="off" /></Field>
          <Field id={`${uid}-e`} label="Owner’s email"><input id={`${uid}-e`} type="email" value={who.email} onChange={(e) => setWho((p) => ({ ...p, email: e.target.value }))} className={fieldClass} required maxLength={160} autoComplete="off" /></Field>
          <div className="sm:col-span-2"><button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button></div>
        </form>
      ) : null}
    </section>
  );
}
