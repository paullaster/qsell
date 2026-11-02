import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/bcrypt';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  users,
  vendorEvents,
  vendorInvitations,
  vendorUsers,
  vendors,
  type VendorInvitationRow,
  type VendorPortalRole,
} from '@/server/db/drizzle/schema';
import type { UserRepository } from '@/server/domains/auth/user-repository';
import type { AuthTokenRepository } from '@/server/domains/auth/token-repository';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const MAX_PEOPLE = 10;
export const INVITABLE_ROLES: readonly VendorPortalRole[] = ['finance', 'sales', 'readonly'];

export interface Invitee {
  email: string;
  name: string;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Durable, one-use access invitations. Vendor-user membership is created only when an invite is accepted. */
export class VendorInvitationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly users: UserRepository,
    private readonly legacyTokens: AuthTokenRepository,
    private readonly notify: VendorNotifier,
  ) {}

  private validated(who: Invitee): Invitee {
    const email = who.email.trim().toLowerCase();
    const name = who.name.trim();
    if (!EMAIL.test(email) || email.length > 160) {
      throw new ProfileError('INVALID', 'Enter a valid email address.', { email: 'Enter a valid email address.' });
    }
    if (name.length < 2 || name.length > 120 || /^test\s+users?$/i.test(name)) {
      throw new ProfileError('INVALID', 'Enter the invitee’s real name. It will be shown in their vendor account and invitation email.', { name: 'Enter the invitee’s real name.' });
    }
    return { email, name };
  }

  private async create(vendorId: string, companyId: string, businessName: string, whoInput: Invitee, role: VendorPortalRole, invitedBy: string, actorId: string, origin: Record<string, unknown>): Promise<void> {
    const who = this.validated(whoInput);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    let invite: VendorInvitationRow;
    try {
      invite = await this.db.transaction(async (tx) => {
        const [vendor] = await tx.select({ id: vendors.id, legalName: vendors.legalName, status: vendors.status })
          .from(vendors)
          .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
          .for('update');
        if (vendor === undefined) throw new ProfileError('NOT_FOUND', 'That vendor does not exist.');
        if (vendor.status === 'archived') throw new ProfileError('NOT_ALLOWED', 'An archived vendor cannot be given a portal invitation.');

        await tx.update(vendorInvitations)
          .set({ status: 'expired', updatedAt: now })
          .where(and(eq(vendorInvitations.vendorId, vendorId), eq(vendorInvitations.status, 'pending'), sql`${vendorInvitations.expiresAt} <= ${now}`));

        const existingUser = await tx.select({ id: users.id, role: users.role })
          .from(users).where(eq(users.email, who.email)).for('update');
        if (existingUser.length > 0) {
          const account = existingUser[0];
          if (account !== undefined) {
            const [membership] = await tx.select({ vendorId: vendorUsers.vendorId })
              .from(vendorUsers)
              .where(and(eq(vendorUsers.userId, account.id), eq(vendorUsers.status, 'active')));
            if (membership?.vendorId === vendorId) throw new ProfileError('ALREADY_JOINED', 'This person already has access to this vendor account.');
            if (account.role !== 'customer') throw new ProfileError('ACCOUNT_LINK_UNAVAILABLE', 'This email already has a qsell login that cannot be linked to the vendor portal. Invite a new vendor portal email or contact the buyer.');
          }
        }

        const [members] = await tx.select({ n: sql<number>`count(*)::int` }).from(vendorUsers)
          .where(and(eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active')));
        const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(vendorInvitations)
          .where(and(eq(vendorInvitations.vendorId, vendorId), eq(vendorInvitations.status, 'pending')));
        if ((members?.n ?? 0) + (pending?.n ?? 0) >= MAX_PEOPLE) {
          throw new ProfileError('TOO_MANY', `That is more people than one vendor account can have (${String(MAX_PEOPLE)}).`);
        }
        if (role === 'owner') {
          const [owner] = await tx.select({ id: vendorUsers.id }).from(vendorUsers)
            .where(and(eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.portalRole, 'owner'), eq(vendorUsers.status, 'active')));
          const [pendingOwner] = await tx.select({ id: vendorInvitations.id }).from(vendorInvitations)
            .where(and(eq(vendorInvitations.vendorId, vendorId), eq(vendorInvitations.portalRole, 'owner'), eq(vendorInvitations.status, 'pending'), gt(vendorInvitations.expiresAt, now)));
          if (owner !== undefined || pendingOwner !== undefined) throw new ProfileError('HAS_OWNER', 'This vendor already has an owner or an owner invitation. Cancel that invitation or ask the existing owner to invite the team.');
        }
        const [row] = await tx.insert(vendorInvitations).values({
          companyId,
          vendorId,
          email: who.email,
          inviteeName: who.name,
          portalRole: role,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          createdBy: invitedBy,
        }).returning();
        if (row === undefined) throw new Error('The invitation was not saved.');
        await tx.insert(vendorEvents).values({
          vendorId,
          event: 'portal_invitation_created',
          data: { email: who.email, name: who.name, role, invitationId: row.id },
          actorType: 'user',
          actorId: actorId === '' ? null : actorId,
          origin: { ...origin, surface: origin.surface ?? 'vendor/invitation', action: 'invite' },
        });
        return row;
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new ProfileError('ALREADY_INVITED', 'There is already a pending invitation for this email. Resend it from the vendor team list.');
      }
      throw error;
    }
    await this.deliver(invite, who.name, businessName, token);
  }

  private async deliver(invite: VendorInvitationRow, name: string, businessName: string, token: string): Promise<void> {
    try {
      await this.notify.invitation(
        invite.email,
        name,
        businessName,
        `/vendor/invitations/accept?token=${encodeURIComponent(token)}`,
        invite.portalRole,
      );
      await this.db.transaction(async (tx) => {
        await tx.update(vendorInvitations)
          .set({ deliveryStatus: 'sent', deliveryError: null, updatedAt: new Date() })
          .where(and(eq(vendorInvitations.id, invite.id), eq(vendorInvitations.status, 'pending')));
        await tx.insert(vendorEvents).values({ vendorId: invite.vendorId, event: 'portal_invitation_email_sent', data: { invitationId: invite.id, email: invite.email }, actorType: 'system', actorId: null, origin: { surface: 'vendor/invitation', action: 'email_delivery' } });
      });
    } catch {
      await this.db.transaction(async (tx) => {
        await tx.update(vendorInvitations)
          .set({ deliveryStatus: 'failed', deliveryError: 'Email delivery failed. Check mail settings and resend.', updatedAt: new Date() })
          .where(and(eq(vendorInvitations.id, invite.id), eq(vendorInvitations.status, 'pending')));
        await tx.insert(vendorEvents).values({ vendorId: invite.vendorId, event: 'portal_invitation_email_failed', data: { invitationId: invite.id, email: invite.email }, actorType: 'system', actorId: null, origin: { surface: 'vendor/invitation', action: 'email_delivery' } });
      });
      throw new ProfileError('EMAIL_DELIVERY_FAILED', 'The invitation is saved, but its email was not delivered. Check email settings, then use Resend invitation.');
    }
  }

  async inviteColleague(actor: PortalActor, who: Invitee, role: string): Promise<void> {
    if (actor.portalRole !== 'owner') throw new ProfileError('NOT_ALLOWED', 'Only the owner of the vendor account can invite people.');
    if (!INVITABLE_ROLES.includes(role as VendorPortalRole)) throw new ProfileError('INVALID', 'Choose finance, sales or read-only.', { role: 'Choose a role.' });
    const [vendor] = await this.db.select({ name: vendors.legalName, companyId: vendors.companyId, status: vendors.status, block: vendors.block })
      .from(vendors).where(eq(vendors.id, actor.vendorId));
    if (vendor === undefined || vendor.status === 'archived') throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    if (vendor.block === 'all') throw new ProfileError('NOT_ALLOWED', 'Your vendor account is blocked from all activity. Contact the buyer before inviting a team member.');
    await this.create(actor.vendorId, vendor.companyId, vendor.name, who, role as VendorPortalRole, actor.userId, actor.userId, { surface: 'vendor/portal', action: 'invite' });
  }

  async inviteOwner(ctx: FinanceContext, vendorId: string, who: Invitee): Promise<void> {
    const [vendor] = await this.db.select({ name: vendors.legalName }).from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
    if (vendor === undefined) throw new ProfileError('NOT_FOUND', 'That vendor does not exist.');
    try {
      await this.create(vendorId, ctx.companyId, vendor.name, who, 'owner', ctx.actor.id ?? 'staff', ctx.actor.id ?? '', { ...ctx.origin, surface: 'vendors/invite', action: 'invite_owner' });
    } catch (error) {
      if (error instanceof ProfileError) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }

  async preview(token: string) {
    if (!TOKEN.test(token)) return null;
    const [row] = await this.db.select({ invitation: vendorInvitations, businessName: vendors.legalName })
      .from(vendorInvitations).innerJoin(vendors, eq(vendors.id, vendorInvitations.vendorId))
      .where(and(eq(vendorInvitations.tokenHash, hashToken(token)), eq(vendorInvitations.status, 'pending'), gt(vendorInvitations.expiresAt, new Date())));
    if (row === undefined) return null;
    const [existing] = await this.db.select({ id: users.id, role: users.role, isActive: users.isActive, status: users.status }).from(users).where(eq(users.email, row.invitation.email));
    const membership = existing === undefined ? undefined : (await this.db.select({ vendorId: vendorUsers.vendorId }).from(vendorUsers).where(and(eq(vendorUsers.userId, existing.id), eq(vendorUsers.status, 'active')))).at(0);
    const canLinkExisting = existing?.role === 'customer'
      && existing.isActive
      && existing.status !== 'suspended'
      && membership === undefined;
    return {
      name: row.invitation.inviteeName,
      email: row.invitation.email,
      role: row.invitation.portalRole,
      businessName: row.businessName,
      expiresAt: row.invitation.expiresAt.toISOString(),
      existingAccount: existing !== undefined,
      existingAccountUnavailable: existing !== undefined && !canLinkExisting,
    };
  }

  /** Creates the portal login only after the recipient proves possession of the invitation link. */
  async accept(token: string, password: string, currentUserId: string | null): Promise<boolean> {
    if (!TOKEN.test(token)) throw new ProfileError('INVALID_INVITATION', 'This invitation link is invalid or has expired. Ask the buyer to send a fresh invitation.');
    const tokenHash = hashToken(token);
    const preview = await this.preview(token);
    if (preview === null) throw new ProfileError('INVALID_INVITATION', 'This invitation is no longer pending or has expired. Ask the buyer to send a fresh invitation.');
    if (preview.existingAccountUnavailable) throw new ProfileError('ACCOUNT_LINK_UNAVAILABLE', 'This existing qsell login cannot be linked to this vendor account. Contact the buyer to arrange a new portal email or account review.');
    const passwordHash = preview.existingAccount ? null : await hash(password, 12);
    let linkedExisting = false;
    try {
      await this.db.transaction(async (tx) => {
        const [invite] = await tx.select().from(vendorInvitations)
          .where(and(eq(vendorInvitations.tokenHash, tokenHash), eq(vendorInvitations.status, 'pending'), gt(vendorInvitations.expiresAt, new Date())))
          .for('update');
      if (invite === undefined) throw new ProfileError('INVALID_INVITATION', 'This invitation is no longer pending or has expired. Ask the buyer to send a fresh invitation.');
        const [vendor] = await tx.select({ status: vendors.status }).from(vendors).where(and(eq(vendors.id, invite.vendorId), eq(vendors.companyId, invite.companyId))).for('update');
        if (vendor === undefined || vendor.status === 'archived') throw new ProfileError('NOT_ALLOWED', 'This vendor account is no longer accepting portal access. Contact the buyer.');
        const [existing] = await tx.select().from(users).where(eq(users.email, invite.email)).for('update');
        let userId: string;
        if (existing !== undefined) {
          if (existing.role !== 'customer' || !existing.isActive || existing.status === 'suspended') {
            throw new ProfileError('ACCOUNT_LINK_UNAVAILABLE', 'This existing qsell login cannot be linked to this vendor account. Contact the buyer to arrange a new portal email or account review.');
          }
          if (currentUserId !== null && existing.id !== currentUserId) throw new ProfileError('ACCOUNT_MISMATCH', 'You are signed in with a different account. Sign in with the invited email or sign out before accepting.');
          const [membership] = await tx.select({ vendorId: vendorUsers.vendorId }).from(vendorUsers).where(and(eq(vendorUsers.userId, existing.id), eq(vendorUsers.status, 'active')));
          if (membership?.vendorId === invite.vendorId) throw new ProfileError('ALREADY_JOINED', 'This account already has access to this vendor portal. Return to the vendor portal sign-in page.');
          if (membership !== undefined) throw new ProfileError('ACCOUNT_LINK_UNAVAILABLE', 'This qsell login is already linked to another vendor business. Contact the buyer to review account access.');
          userId = existing.id;
          linkedExisting = true;
          await tx.update(users).set({ emailVerifiedAt: existing.emailVerifiedAt ?? new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
        } else {
          if (currentUserId !== null) throw new ProfileError('ACCOUNT_MISMATCH', 'Sign out before accepting this invitation to create a separate vendor login.');
          if (passwordHash === null) throw new ProfileError('ACCOUNT_MISMATCH', 'This invitation needs a new vendor password. Refresh the invitation and try again.');
          userId = randomUUID();
          await tx.insert(users).values({
            id: userId,
            email: invite.email,
            name: invite.inviteeName,
            passwordHash,
            role: 'vendor',
            emailVerifiedAt: new Date(),
            isActive: true,
          });
        }
        await tx.insert(vendorUsers).values({ vendorId: invite.vendorId, userId, portalRole: invite.portalRole, invitedBy: invite.createdBy });
        await tx.update(vendorInvitations).set({ status: 'accepted', acceptedBy: userId, acceptedAt: new Date(), updatedAt: new Date() }).where(eq(vendorInvitations.id, invite.id));
        await tx.insert(vendorEvents).values({ vendorId: invite.vendorId, event: 'portal_invitation_accepted', data: { email: invite.email, role: invite.portalRole, invitationId: invite.id }, actorType: 'user', actorId: userId, origin: { surface: 'vendor/invitation', action: 'accept' } });
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') throw new ProfileError('INVITATION_CONFLICT', 'This invitation could not be linked because the account already belongs to another vendor. Contact the buyer.');
      throw error;
    }
    return linkedExisting;
  }

  async resend(vendorId: string, invitationId: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const invite = await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ invitation: vendorInvitations, businessName: vendors.legalName })
        .from(vendorInvitations).innerJoin(vendors, eq(vendors.id, vendorInvitations.vendorId))
        .where(and(eq(vendorInvitations.id, invitationId), eq(vendorInvitations.vendorId, vendorId), inArray(vendorInvitations.status, ['pending', 'expired'])))
        .for('update', { of: vendorInvitations });
      if (row === undefined) return null;
      if (row.invitation.status === 'expired') return { expired: true as const, invitation: row.invitation, businessName: row.businessName };
      const [updated] = await tx.update(vendorInvitations).set({ tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), deliveryStatus: 'pending', deliveryError: null, updatedAt: new Date() }).where(eq(vendorInvitations.id, invitationId)).returning();
      await tx.insert(vendorEvents).values({ vendorId, event: 'portal_invitation_resent', data: { invitationId, email: row.invitation.email, role: row.invitation.portalRole }, actorType: 'system', actorId: null, origin: { surface: 'vendor/invitation', action: 'resend' } });
      return updated === undefined ? null : { expired: false as const, invitation: updated, businessName: row.businessName };
    });
    if (invite !== null) {
      if (invite.expired) {
        await this.create(
          vendorId,
          invite.invitation.companyId,
          invite.businessName,
          { email: invite.invitation.email, name: invite.invitation.inviteeName },
          invite.invitation.portalRole,
          invite.invitation.createdBy,
          invite.invitation.createdBy,
          { surface: 'vendor/invitation', action: 'resend_expired' },
        );
        return;
      }
      await this.deliver(invite.invitation, invite.invitation.inviteeName, invite.businessName, token);
      return;
    }

    // Preserve resend for invitations issued before durable invitation records were introduced.
    const [legacy] = await this.db.select({ vu: vendorUsers, email: users.email, name: users.name, verified: users.emailVerifiedAt, legalName: vendors.legalName })
      .from(vendorUsers).innerJoin(users, eq(users.id, vendorUsers.userId)).innerJoin(vendors, eq(vendors.id, vendorUsers.vendorId))
      .where(and(eq(vendorUsers.id, invitationId), eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active')));
    if (legacy?.verified !== null) throw new ProfileError('NOT_FOUND', 'That pending invitation could not be found. Refresh the page and invite the person again.');
    const reset = await this.legacyTokens.issue(legacy.vu.userId, 'password_reset', INVITE_TTL_MS);
    await this.notify.invitation(legacy.email, legacy.name, legacy.legalName, `/reset-password?token=${encodeURIComponent(reset)}`, legacy.vu.portalRole);
  }

  async remove(vendorId: string, personId: string, by: { type: 'user'; id: string }, origin: Record<string, unknown>): Promise<void> {
    const [invite] = await this.db.select().from(vendorInvitations)
      .where(and(eq(vendorInvitations.id, personId), eq(vendorInvitations.vendorId, vendorId), eq(vendorInvitations.status, 'pending')));
    if (invite !== undefined) {
      await this.db.transaction(async (tx) => {
        await tx.update(vendorInvitations).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() }).where(eq(vendorInvitations.id, invite.id));
        await tx.insert(vendorEvents).values({ vendorId, event: 'portal_invitation_revoked', data: { email: invite.email, role: invite.portalRole, invitationId: invite.id }, actorType: by.type, actorId: by.id, origin });
      });
      return;
    }
    const [row] = await this.db.select({ vu: vendorUsers, email: users.email, verified: users.emailVerifiedAt, role: users.role })
      .from(vendorUsers).innerJoin(users, eq(users.id, vendorUsers.userId))
      .where(and(eq(vendorUsers.id, personId), eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active')));
    if (row === undefined) throw new ProfileError('NOT_FOUND', 'That person is not on this vendor account.');
    if (row.vu.portalRole === 'owner' && row.verified !== null) throw new ProfileError('NOT_ALLOWED', 'The owner cannot be removed. Ask the buyer to transfer the account first.');
    if (row.vu.userId === by.id) throw new ProfileError('NOT_ALLOWED', 'You cannot remove yourself.');
    await this.db.transaction(async (tx) => {
      if (row.verified === null) {
        await tx.delete(vendorUsers).where(eq(vendorUsers.id, personId));
        await tx.delete(users).where(and(eq(users.id, row.vu.userId), isNull(users.emailVerifiedAt)));
      } else if (row.role === 'customer') {
        // A customer login may also be a vendor portal login; removing one membership must not disable the shopper account.
        await tx.update(vendorUsers).set({ status: 'removed' }).where(eq(vendorUsers.id, personId));
      } else {
        await tx.update(vendorUsers).set({ status: 'removed' }).where(eq(vendorUsers.id, personId));
        await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, row.vu.userId));
      }
      await tx.insert(vendorEvents).values({ vendorId, event: 'portal_user_removed', data: { email: row.email, role: row.vu.portalRole }, actorType: by.type, actorId: by.id, origin });
    });
  }

  async team(vendorId: string) {
    const [members, invitations] = await Promise.all([
      this.db.select({ id: vendorUsers.id, name: users.name, email: users.email, role: vendorUsers.portalRole, status: vendorUsers.status, joined: users.emailVerifiedAt, lastLoginAt: users.lastLoginAt })
        .from(vendorUsers).innerJoin(users, eq(users.id, vendorUsers.userId)).where(and(eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active'))).orderBy(vendorUsers.createdAt),
      this.db.select().from(vendorInvitations).where(and(eq(vendorInvitations.vendorId, vendorId), inArray(vendorInvitations.status, ['pending', 'expired']))).orderBy(asc(vendorInvitations.createdAt)).limit(30),
    ]);
    return [
      ...members.map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role, status: row.status, joined: row.joined !== null, lastLoginAt: row.lastLoginAt?.toISOString() ?? null, deliveryStatus: null as string | null, expiresAt: null as string | null, expired: false })),
      ...invitations.map((row) => {
        const expired = row.status === 'expired' || row.expiresAt <= new Date();
        return { id: row.id, name: row.inviteeName, email: row.email, role: row.portalRole, status: expired ? 'expired' : 'active', joined: false, lastLoginAt: null as string | null, deliveryStatus: row.deliveryStatus, expiresAt: row.expiresAt.toISOString(), expired };
      }),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }
}
