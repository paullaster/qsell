import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { users, vendorEvents, vendorUsers, vendors, type VendorPortalRole } from '@/server/db/drizzle/schema';
import type { UserRepository } from '@/server/domains/auth/user-repository';
import type { AuthTokenRepository } from '@/server/domains/auth/token-repository';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const MAX_PEOPLE = 10;
export const INVITABLE_ROLES: readonly VendorPortalRole[] = ['finance', 'sales', 'readonly'];

export interface Invitee {
  email: string;
  name: string;
}

/**
 * Giving people a login to a vendor's portal. An invitation creates the login with a password nobody knows and mails a
 * single-use link (valid 7 days) to choose one, so the person proves they own the address by using it. The owner invites
 * colleagues; staff with `vendors:invite` invite the owner of a vendor they added. The answer never says whether an address
 * already has an account.
 */
export class VendorInvitationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly users: UserRepository,
    private readonly tokens: AuthTokenRepository,
    private readonly notify: VendorNotifier,
  ) {}

  private async create(vendorId: string, businessName: string, who: Invitee, role: VendorPortalRole, invitedBy: string, actor: { type: 'user'; id: string }, origin: Record<string, unknown>): Promise<void> {
    const email = who.email.trim().toLowerCase();
    const name = who.name.trim();
    if (!EMAIL.test(email) || email.length > 160) throw new ProfileError('INVALID', 'Enter a valid email address.', { email: 'Enter a valid email address.' });
    if (name.length < 2 || name.length > 120) throw new ProfileError('INVALID', 'Enter the person’s name.', { name: 'Enter the person’s name.' });
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(vendorUsers).where(and(eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active')));
    if ((count?.n ?? 0) >= MAX_PEOPLE) throw new ProfileError('TOO_MANY', `That is more people than one vendor account can have (${String(MAX_PEOPLE)}).`);
    if ((await this.users.findByEmail(email)) !== null) return; // silent: never reveal who has an account
    const user = await this.users.create({ email, password: randomBytes(24).toString('base64url'), name, role: 'vendor', emailVerified: false });
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(vendorUsers).values({ vendorId, userId: user.id, portalRole: role, invitedBy });
        await tx.insert(vendorEvents).values({ vendorId, event: 'portal_user_invited', data: { email, role }, actorType: actor.type, actorId: actor.id, origin });
      });
    } catch (error) {
      await this.users.deleteUnverified(user.id).catch(() => undefined);
      throw error;
    }
    await this.mail(user.id, email, name, businessName, role);
  }

  private async mail(userId: string, email: string, name: string, businessName: string, role: string): Promise<void> {
    const token = await this.tokens.issue(userId, 'password_reset', INVITE_TTL_MS);
    await this.notify.invitation(email, name, businessName, `/reset-password?token=${encodeURIComponent(token)}`, role);
  }

  /** The owner invites a colleague. */
  async inviteColleague(actor: PortalActor, who: Invitee, role: string): Promise<void> {
    if (actor.portalRole !== 'owner') throw new ProfileError('NOT_ALLOWED', 'Only the owner of the vendor account can invite people.');
    if (!INVITABLE_ROLES.includes(role as VendorPortalRole)) throw new ProfileError('INVALID', 'Choose finance, sales or read-only.', { role: 'Choose a role.' });
    const [v] = await this.db.select({ name: vendors.legalName, status: vendors.status }).from(vendors).where(eq(vendors.id, actor.vendorId));
    if (v === undefined || v.status === 'archived') throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    await this.create(actor.vendorId, v.name, who, role as VendorPortalRole, actor.userId, { type: 'user', id: actor.userId }, { surface: 'vendor/portal', action: 'invite' });
  }

  /** Staff invite the owner of a vendor that has none (a vendor added by staff). */
  async inviteOwner(ctx: FinanceContext, vendorId: string, who: Invitee): Promise<void> {
    const [v] = await this.db.select({ name: vendors.legalName, status: vendors.status }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    if (v.status === 'archived') throw new FinanceError('NOT_ALLOWED', 'An archived vendor cannot be given a login.');
    const [owner] = await this.db.select({ id: vendorUsers.id }).from(vendorUsers).where(and(eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.portalRole, 'owner'), eq(vendorUsers.status, 'active')));
    if (owner !== undefined) throw new FinanceError('HAS_OWNER', 'This vendor already has an owner. The owner invites the rest of the team.');
    try {
      await this.create(vendorId, v.name, who, 'owner', ctx.actor.id ?? 'staff', { type: 'user', id: ctx.actor.id ?? '' }, { ...ctx.origin });
    } catch (error) {
      if (error instanceof ProfileError) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }

  private async pendingOf(vendorId: string, vendorUserId: string) {
    const [row] = await this.db
      .select({ vu: vendorUsers, email: users.email, name: users.name, verified: users.emailVerifiedAt, legalName: vendors.legalName })
      .from(vendorUsers)
      .innerJoin(users, eq(users.id, vendorUsers.userId))
      .innerJoin(vendors, eq(vendors.id, vendorUsers.vendorId))
      .where(and(eq(vendorUsers.id, vendorUserId), eq(vendorUsers.vendorId, vendorId), eq(vendorUsers.status, 'active')));
    return row;
  }

  /** Mails a fresh link to someone who has not used their invitation yet (the old link stops working). */
  async resend(vendorId: string, vendorUserId: string): Promise<void> {
    const row = await this.pendingOf(vendorId, vendorUserId);
    if (row === undefined) throw new FinanceError('NOT_FOUND', 'That person is not on this vendor account.');
    if (row.verified !== null) throw new FinanceError('ALREADY_JOINED', 'This person has already joined.');
    await this.mail(row.vu.userId, row.email, row.name, row.legalName, row.vu.portalRole);
  }

  /**
   * Takes someone off the account. An invitation nobody used is deleted with its login; a person who joined keeps their history but
   * their login is switched off. The owner cannot be removed this way.
   */
  async remove(vendorId: string, vendorUserId: string, by: { type: 'user'; id: string }, origin: Record<string, unknown>): Promise<void> {
    const row = await this.pendingOf(vendorId, vendorUserId);
    if (row === undefined) throw new FinanceError('NOT_FOUND', 'That person is not on this vendor account.');
    if (row.vu.portalRole === 'owner') throw new FinanceError('NOT_ALLOWED', 'The owner cannot be removed. Ask us to transfer the account first.');
    if (row.vu.userId === by.id) throw new FinanceError('NOT_ALLOWED', 'You cannot remove yourself.');
    await this.db.transaction(async (tx) => {
      if (row.verified === null) {
        await tx.delete(vendorUsers).where(eq(vendorUsers.id, vendorUserId));
        await tx.delete(users).where(and(eq(users.id, row.vu.userId), sql`${users.emailVerifiedAt} IS NULL`));
      } else {
        await tx.update(vendorUsers).set({ status: 'removed' }).where(eq(vendorUsers.id, vendorUserId));
        await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, row.vu.userId));
      }
      await tx.insert(vendorEvents).values({ vendorId, event: 'portal_user_removed', data: { email: row.email, role: row.vu.portalRole }, actorType: by.type, actorId: by.id, origin });
    });
  }

  /** The people on a vendor account, and whether each has accepted. */
  async team(vendorId: string) {
    const rows = await this.db
      .select({ id: vendorUsers.id, name: users.name, email: users.email, role: vendorUsers.portalRole, status: vendorUsers.status, joined: users.emailVerifiedAt })
      .from(vendorUsers)
      .innerJoin(users, eq(users.id, vendorUsers.userId))
      .where(and(eq(vendorUsers.vendorId, vendorId), inArray(vendorUsers.status, ['active'])))
      .orderBy(vendorUsers.createdAt);
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, joined: r.joined !== null }));
  }
}

