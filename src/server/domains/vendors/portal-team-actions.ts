'use server';

import { getContainer } from '@/server/di/container';
import { DESTINATION_KINDS, type DestinationKind } from '@/lib/vendor-profile';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 200): string => (typeof value === 'string' ? value.slice(0, max) : '');
const fields = (raw: unknown): Record<string, unknown> => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {});

/** Who is on the vendor account, and what the owner may do about it. */
export async function teamAction() {
  return await portal('team', async (me) => {
    const container = getContainer();
    return { people: await container.vendorInvitations.team(me.vendorId), canManage: me.portalRole === 'owner', you: me.userId };
  });
}

/**
 * The owner invites a colleague. The answer is the same whatever the address, so the form cannot be used to find out who has an
 * account elsewhere.
 */
export async function inviteColleagueAction(raw: unknown) {
  return await portal('team_invite', async (me) => {
    const f = fields(raw);
    await getContainer().vendorInvitations.inviteColleague(me, { email: str(f.email), name: str(f.name) }, str(f.role, 20));
    return { message: 'If that address can be invited, we have emailed them a link to choose a password.' };
  });
}

export async function resendInvitationAction(vendorUserId: unknown) {
  return await portal('team_resend', async (me) => {
    if (me.portalRole !== 'owner') throw new ProfileError('NOT_ALLOWED', 'Only the owner of the vendor account can do that.');
    await getContainer().vendorInvitations.resend(me.vendorId, idOf(vendorUserId));
  });
}

export async function removeTeamMemberAction(vendorUserId: unknown) {
  return await portal('team_remove', async (me) => {
    if (me.portalRole !== 'owner') throw new ProfileError('NOT_ALLOWED', 'Only the owner of the vendor account can do that.');
    await getContainer().vendorInvitations.remove(me.vendorId, idOf(vendorUserId), { type: 'user', id: me.userId }, { surface: 'vendor/portal', action: 'team_remove' });
  });
}

/** An approved vendor's bank accounts and any change waiting. Numbers are never sent, only the last four digits. */
export async function bankStatusAction() {
  return await portal('bank_status', async (me) => {
    const container = getContainer();
    const [loaded, pending] = await Promise.all([container.vendorProfile.load(me.companyId, me.vendorId), container.vendorBank.forVendor(me.vendorId)]);
    if (loaded === null) throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    const letters = loaded.documents.filter((d) => loaded.types.find((t) => t.id === d.doc.documentTypeId)?.code === 'BANK_LETTER' && (d.doc.status === 'submitted' || d.doc.status === 'valid'));
    return {
      active: loaded.vendor.status === 'active',
      canPropose: loaded.vendor.status === 'active' && (me.portalRole === 'owner' || me.portalRole === 'finance'),
      accounts: loaded.banks.filter((b) => b.status === 'active').map((b) => ({ id: b.id, kind: b.kind, bankName: b.bankName, branch: b.branch, accountName: b.accountName, last4: b.accountLast4 })),
      pending,
      bankLetters: letters.map((d) => ({ id: d.doc.id, fileName: d.fileName })),
    };
  });
}

const kindFrom = (value: unknown): DestinationKind => (DESTINATION_KINDS.some((k) => k.id === value) ? (value as DestinationKind) : 'bank');

export async function proposeBankChangeAction(raw: unknown) {
  return await portal('bank_propose', async (me) => {
    const f = fields(raw);
    const made = await getContainer().vendorBank.propose(me, {
      bankName: str(f.bankName),
      branch: str(f.branch),
      accountName: str(f.accountName),
      accountNumber: str(f.accountNumber, 40),
      swift: str(f.swift, 20),
      kind: kindFrom(f.kind),
      reference: str(f.reference, 20),
      replacesId: str(f.replacesId, 40) === '' ? '' : idOf(f.replacesId),
      evidenceDocumentId: idOf(f.evidenceDocumentId),
    });
    return made;
  });
}

export async function withdrawBankChangeAction(changeId: unknown) {
  return await portal('bank_withdraw', async (me) => {
    await getContainer().vendorBank.withdraw(me, idOf(changeId));
  });
}
