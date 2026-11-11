import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveryRiderSettings, deliveryRiders, deliveryRuns, riderPins, roles, users } from '@/server/db/drizzle/schema';
import { RIDER_KIND_WORDS, RIDER_STATUS_WORDS, RIDER_STATUSES, dialable, isRiderKind, kindsProblem, mayCarry, riderStatusAfter, type RiderKind, type RiderKinds, type RiderStatus } from '@/lib/delivery-rider';
import { isProofRule, type ProofRule } from '@/lib/delivery-proof';
import { validatePassword } from '@/lib/passwordPolicy';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { UsersAdminRepository } from '@/server/domains/users/repository';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE = 25;
/** The role a rider with an account of their own has: never staff, nothing in the back office. */
export const RIDER_ROLE = 'rider';

export interface RiderSettingsView extends RiderKinds {
  /** What a rider must show to mark a delivery delivered. */
  proof: ProofRule;
  version: number;
  /** People riding or paused, by kind: what blocks switching a kind off. */
  working: Record<RiderKind, number>;
}

export interface RiderView {
  id: string;
  userId: string;
  name: string;
  email: string;
  kind: RiderKind;
  kindWords: string;
  phone: string | null;
  vehicle: string | null;
  branchId: string | null;
  branchName: string | null;
  status: RiderStatus;
  statusWords: string;
  statusReason: string | null;
  version: number;
  /** Runs planned or out with them, for the list and for the check before they leave. */
  openRuns: number;
}

/** What the rider app needs to know about who is using it. */
export interface RiderSelf {
  riderId: string;
  companyId: string;
  userId: string;
  name: string;
  kind: RiderKind;
  phone: string | null;
}

/**
 * The people who carry deliveries. A company chooses which kinds it uses: its own staff signing in to the rider app with the
 * account they have, riders with an account made for riding (a role that can never open the back office), or both. The rider
 * app lets someone in by their row here, so the permission engine (which is for staff) is not in the way of a separate account.
 */
export class DeliveryRiders {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly accounts: Pick<UsersAdminRepository, 'createUser' | 'resetPassword'>,
  ) {}

  /** Which kinds are used; staff only until the company says otherwise. */
  async settings(companyId: string): Promise<RiderSettingsView> {
    return await this.settingsIn(this.db, companyId);
  }

  private async settingsIn(db: Tx | DrizzleDb, companyId: string): Promise<RiderSettingsView> {
    const [row] = await db.select().from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, companyId));
    const counts = await db
      .select({ kind: deliveryRiders.kind, n: sql<number>`count(*)::int` })
      .from(deliveryRiders)
      .where(and(eq(deliveryRiders.companyId, companyId), inArray(deliveryRiders.status, ['active', 'paused'])))
      .groupBy(deliveryRiders.kind);
    const working: Record<RiderKind, number> = { staff: 0, separate: 0 };
    for (const c of counts) working[c.kind] = c.n;
    return { allowStaff: row?.allowStaff ?? true, allowSeparate: row?.allowSeparate ?? false, proof: row?.proof ?? 'none', version: row?.version ?? 0, working };
  }

  async setKinds(actor: DocActor, input: { allowStaff?: unknown; allowSeparate?: unknown; expectedVersion?: unknown }): Promise<DocResult<RiderSettingsView>> {
    if (typeof input.allowStaff !== 'boolean' || typeof input.allowSeparate !== 'boolean') return fail('bad_input', 'Choose the kinds of rider the company uses.');
    const next: RiderKinds = { allowStaff: input.allowStaff, allowSeparate: input.allowSeparate };
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    return await this.db.transaction(async (tx): Promise<DocResult<RiderSettingsView>> => {
      await tx.insert(deliveryRiderSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      // A company that has never saved the choice shows version 0; the row made just above is version 1.
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      const now = await this.settingsIn(tx, actor.companyId);
      const problem = kindsProblem(next, now.working);
      if (problem !== null) return fail('not_allowed', problem);
      if (row.allowStaff !== next.allowStaff || row.allowSeparate !== next.allowSeparate) {
        await tx.update(deliveryRiderSettings).set({ ...next, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryRiderSettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_riders', id: actor.companyId }, action: 'riders.kinds_set', actor: { type: 'user', id: actor.userId }, from: JSON.stringify({ staff: row.allowStaff, separate: row.allowSeparate }), to: JSON.stringify({ staff: next.allowStaff, separate: next.allowSeparate }) }, tx);
      }
      return { ok: true, data: await this.settingsIn(tx, actor.companyId) };
    });
  }

  /** What a rider must show at the door. Versioned like the kinds, and every change is in the decision log. */
  async setProof(actor: DocActor, input: { proof?: unknown; expectedVersion?: unknown }): Promise<DocResult<RiderSettingsView>> {
    if (!isProofRule(input.proof)) return fail('bad_input', 'Choose what a rider must show at the door.');
    const proof = input.proof;
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    return await this.db.transaction(async (tx): Promise<DocResult<RiderSettingsView>> => {
      await tx.insert(deliveryRiderSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      if (row.proof !== proof) {
        await tx.update(deliveryRiderSettings).set({ proof, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryRiderSettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_riders', id: actor.companyId }, action: 'riders.proof_set', actor: { type: 'user', id: actor.userId }, from: row.proof, to: proof }, tx);
      }
      return { ok: true, data: await this.settingsIn(tx, actor.companyId) };
    });
  }

  /** A member of staff starts riding with the account they have. */
  async addStaff(actor: DocActor, input: { userId?: unknown; phone?: unknown; vehicle?: unknown; branchId?: unknown }): Promise<DocResult<{ id: string }>> {
    if (typeof input.userId !== 'string' || input.userId === '') return fail('bad_input', 'Choose the member of staff.');
    const userId = input.userId;
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string }>> => {
      const kinds = await this.settingsIn(tx, actor.companyId);
      if (!kinds.allowStaff) return fail('not_allowed', 'Staff are not set to ride. Switch staff on in the rider settings first.');
      const [person] = await tx.select({ id: users.id, name: users.name, phone: users.phone, status: users.status, isActive: users.isActive, role: users.role }).from(users).where(eq(users.id, userId));
      if (person === undefined) return fail('not_found', 'That person could not be found.');
      if (!person.isActive || person.status !== 'active') return fail('not_allowed', 'That account is switched off.');
      if (!(await this.isStaffRole(tx, person.role))) return fail('not_allowed', 'That account is not a member of staff. Make an own account for the rider instead.');
      const [already] = await tx.select({ id: deliveryRiders.id, status: deliveryRiders.status }).from(deliveryRiders).where(and(eq(deliveryRiders.companyId, actor.companyId), eq(deliveryRiders.userId, userId)));
      if (already !== undefined) return fail('conflict', already.status === 'ended' ? 'They rode before. Resume them from the list of riders.' : 'They are already a rider.');
      const placed = await this.placeOf(tx, actor.companyId, input.branchId);
      if (!placed.ok) return placed;
      const id = crypto.randomUUID();
      await tx.insert(deliveryRiders).values({ id, companyId: actor.companyId, userId, kind: 'staff', name: person.name, phone: text(input.phone, 40) ?? person.phone, vehicle: text(input.vehicle, 80), branchId: placed.data, createdBy: actor.userId });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id }, action: 'rider.added', actor: { type: 'user', id: actor.userId }, to: 'active', reason: { text: `${person.name}, staff` } }, tx);
      return { ok: true, data: { id } };
    });
  }

  /** An account made for riding: it opens the rider app and nothing else. The rider must choose their own password at first sign-in. */
  async createSeparate(actor: DocActor, input: { name?: unknown; email?: unknown; phone?: unknown; password?: unknown; vehicle?: unknown; branchId?: unknown }): Promise<DocResult<{ id: string }>> {
    const name = text(input.name, 120);
    if (name === null) return fail('bad_input', 'Give the rider’s name.');
    const email = text(input.email, 200)?.toLowerCase() ?? null;
    if (email === null || !EMAIL.test(email)) return fail('bad_input', 'Give an email address the rider can sign in with.');
    const phone = dialable(typeof input.phone === 'string' ? input.phone : null);
    if (phone === null) return fail('bad_input', 'Give the rider’s phone number.');
    const password = typeof input.password === 'string' ? input.password : '';
    const weak = validatePassword(password);
    if (weak !== null) return fail('bad_input', weak);
    const kinds = await this.settings(actor.companyId);
    if (!kinds.allowSeparate) return fail('not_allowed', 'Riders with their own accounts are not switched on. Switch them on in the rider settings first.');
    const placed = await this.placeOf(this.db, actor.companyId, input.branchId);
    if (!placed.ok) return placed;
    const [taken] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken !== undefined) return fail('conflict', 'An account with that email already exists. If they are on the staff, add them as a staff rider.');
    const account = await this.accounts.createUser({ email, password, name, phone, role: RIDER_ROLE, branchId: placed.data });
    const id = crypto.randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(deliveryRiders).values({ id, companyId: actor.companyId, userId: account.id, kind: 'separate', name, phone, vehicle: text(input.vehicle, 80), branchId: placed.data, createdBy: actor.userId });
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id }, action: 'rider.added', actor: { type: 'user', id: actor.userId }, to: 'active', reason: { text: `${name}, own account` } }, tx);
      });
    } catch (error) {
      // The account was made a moment ago for this rider alone; do not leave it behind without a rider.
      await this.db.delete(users).where(eq(users.id, account.id));
      throw error;
    }
    return { ok: true, data: { id } };
  }

  /** A branch the rider belongs to, or none: must be this company's own and in use. */
  private async placeOf(db: Tx | DrizzleDb, companyId: string, value: unknown): Promise<DocResult<string | null>> {
    if (typeof value !== 'string' || value === '') return { ok: true, data: null };
    const [branch] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, value), eq(branches.companyId, companyId), eq(branches.isActive, true)));
    return branch === undefined ? fail('not_found', 'That branch could not be found.') : { ok: true, data: branch.id };
  }

  private async isStaffRole(db: Tx | DrizzleDb, roleKey: string): Promise<boolean> {
    if (roleKey === 'super_admin') return true;
    const [role] = await db.select({ isStaff: roles.isStaff, isActive: roles.isActive }).from(roles).where(eq(roles.key, roleKey));
    return role?.isStaff === true && role.isActive;
  }

  async update(actor: DocActor, riderId: string, input: { name?: unknown; phone?: unknown; vehicle?: unknown; branchId?: unknown; expectedVersion?: unknown }): Promise<DocResult<RiderView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RiderView>> => {
      const found = await this.lock(tx, actor.companyId, riderId, input.expectedVersion);
      if (!found.ok) return found;
      const name = input.name === undefined ? found.data.name : text(input.name, 120);
      if (name === null) return fail('bad_input', 'Give the rider’s name.');
      let phone = found.data.phone;
      if (input.phone !== undefined) {
        phone = typeof input.phone === 'string' && input.phone.trim() === '' ? null : dialable(typeof input.phone === 'string' ? input.phone : null);
        if (phone === null && typeof input.phone === 'string' && input.phone.trim() !== '') return fail('bad_input', 'That phone number does not look right.');
        if (phone === null && found.data.kind === 'separate') return fail('bad_input', 'A rider with their own account needs a phone number.');
      }
      let branchId = found.data.branchId;
      if (input.branchId !== undefined) {
        const placed = await this.placeOf(tx, actor.companyId, input.branchId);
        if (!placed.ok) return placed;
        branchId = placed.data;
      }
      await tx.update(deliveryRiders).set({ name, phone, vehicle: input.vehicle === undefined ? found.data.vehicle : text(input.vehicle, 80), branchId, version: found.data.version + 1, updatedAt: new Date() }).where(eq(deliveryRiders.id, riderId));
      // The PIN belongs to the number it was given for: a new number turns the PIN off, and the office gives a new one.
      if (phone !== found.data.phone) {
        const gone = await tx.delete(riderPins).where(eq(riderPins.riderId, riderId)).returning({ id: riderPins.riderId });
        if (gone.length > 0) await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.pin_removed', actor: { type: 'user', id: actor.userId }, reason: { text: 'The phone number changed' } }, tx);
      }
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.updated', actor: { type: 'user', id: actor.userId } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, riderId) };
    });
  }

  /** Pause (a reason is kept), resume, or end riding. A rider with runs still to do cannot be ended or paused: give those runs to someone else first. */
  async change(actor: DocActor, riderId: string, input: { change?: unknown; reason?: unknown; expectedVersion?: unknown }): Promise<DocResult<RiderView>> {
    const change = input.change === 'pause' || input.change === 'resume' || input.change === 'end' ? input.change : null;
    if (change === null) return fail('bad_input', 'That is not something a rider can be.');
    const reason = text(input.reason, 300);
    if (change !== 'resume' && reason === null) return fail('bad_input', change === 'pause' ? 'Say why they are paused.' : 'Say why they have left.');
    return await this.db.transaction(async (tx): Promise<DocResult<RiderView>> => {
      const found = await this.lock(tx, actor.companyId, riderId, input.expectedVersion);
      if (!found.ok) return found;
      const to = riderStatusAfter(found.data.status, change);
      if (to === null) return fail('not_allowed', `They are already ${RIDER_STATUS_WORDS[found.data.status].toLowerCase()}.`);
      if (change !== 'resume') {
        const open = await this.openRunsOf(tx, [riderId]);
        const n = open.get(riderId) ?? 0;
        if (n > 0) return fail('not_allowed', `They still have ${String(n)} ${n === 1 ? 'run' : 'runs'} to do. Give ${n === 1 ? 'it' : 'them'} to another rider first.`);
      }
      if (change === 'resume') {
        const kinds = await this.settingsIn(tx, actor.companyId);
        if (!mayCarry({ status: 'active', kind: found.data.kind }, kinds)) return fail('not_allowed', `${RIDER_KIND_WORDS[found.data.kind]} riders are not switched on. Switch them on in the rider settings first.`);
        const [person] = await tx.select({ status: users.status, isActive: users.isActive }).from(users).where(eq(users.id, found.data.userId));
        if (person === undefined || !person.isActive || person.status !== 'active') return fail('not_allowed', 'Their account is switched off.');
      }
      await tx.update(deliveryRiders).set({ status: to, statusReason: to === 'active' ? null : reason, statusChangedAt: new Date(), version: found.data.version + 1, updatedAt: new Date() }).where(eq(deliveryRiders.id, riderId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: `rider.${change}`, actor: { type: 'user', id: actor.userId }, from: found.data.status, to, ...(reason === null ? {} : { reason: { text: reason } }) }, tx);
      // A rider who has left no longer signs in with a PIN, and the number is free for whoever has it next.
      if (to === 'ended') {
        const gone = await tx.delete(riderPins).where(eq(riderPins.riderId, riderId)).returning({ id: riderPins.riderId });
        if (gone.length > 0) await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.pin_removed', actor: { type: 'user', id: actor.userId }, reason: { text: 'The rider left' } }, tx);
      }
      return { ok: true, data: await this.viewIn(tx, actor.companyId, riderId) };
    });
  }

  /** A new password for a rider with an account of their own; they choose their own at the next sign-in. Staff manage their own passwords. */
  async resetPassword(actor: DocActor, riderId: string, password: unknown): Promise<DocResult<{ done: true }>> {
    const weak = validatePassword(typeof password === 'string' ? password : '');
    if (weak !== null) return fail('bad_input', weak);
    const [rider] = await this.db.select().from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, actor.companyId)));
    if (rider === undefined) return fail('not_found', 'That rider could not be found.');
    if (rider.kind !== 'separate') return fail('not_allowed', 'This is a member of staff. They change their own password.');
    await this.accounts.resetPassword(rider.userId, String(password));
    await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.password_reset', actor: { type: 'user', id: actor.userId } });
    return { ok: true, data: { done: true } };
  }

  private async lock(tx: Tx, companyId: string, riderId: string, expectedVersion: unknown) {
    const [rider] = await tx.select().from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, companyId))).for('update');
    if (rider === undefined) return fail('not_found', 'That rider could not be found.');
    if (typeof expectedVersion === 'number' && expectedVersion !== rider.version) return fail('conflict', 'Someone else changed this rider while you were looking. Reload to see their change.');
    return { ok: true as const, data: rider };
  }

  private async openRunsOf(db: Tx | DrizzleDb, riderIds: string[]): Promise<Map<string, number>> {
    if (riderIds.length === 0) return new Map();
    const rows = await db
      .select({ riderId: deliveryRuns.riderId, n: sql<number>`count(*)::int` })
      .from(deliveryRuns)
      .where(and(inArray(deliveryRuns.riderId, riderIds), inArray(deliveryRuns.status, ['planned', 'started'])))
      .groupBy(deliveryRuns.riderId);
    return new Map(rows.flatMap((r) => (r.riderId === null ? [] : [[r.riderId, r.n] as const])));
  }

  async get(companyId: string, riderId: string): Promise<RiderView | null> {
    const [row] = await this.db.select({ id: deliveryRiders.id }).from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, companyId)));
    return row === undefined ? null : await this.viewIn(this.db, companyId, riderId);
  }

  private async viewIn(db: Tx | DrizzleDb, companyId: string, riderId: string): Promise<RiderView> {
    const rows = await this.rowsFor(db, [eq(deliveryRiders.companyId, companyId), eq(deliveryRiders.id, riderId)], 1);
    const found = rows[0];
    if (found === undefined) throw new Error('rider vanished');
    return found;
  }

  private async rowsFor(db: Tx | DrizzleDb, where: (ReturnType<typeof eq> | undefined)[], limit: number): Promise<RiderView[]> {
    const rows = await db
      .select({ r: deliveryRiders, email: users.email, branchName: branches.name })
      .from(deliveryRiders)
      .innerJoin(users, eq(users.id, deliveryRiders.userId))
      .leftJoin(branches, eq(branches.id, deliveryRiders.branchId))
      .where(and(...where))
      .orderBy(desc(deliveryRiders.createdAt), desc(deliveryRiders.id))
      .limit(limit);
    const open = await this.openRunsOf(db, rows.map((x) => x.r.id));
    return rows.map((x) => ({
      id: x.r.id,
      userId: x.r.userId,
      name: x.r.name,
      email: x.email,
      kind: x.r.kind,
      kindWords: RIDER_KIND_WORDS[x.r.kind],
      phone: x.r.phone,
      vehicle: x.r.vehicle,
      branchId: x.r.branchId,
      branchName: x.branchName,
      status: x.r.status,
      statusWords: RIDER_STATUS_WORDS[x.r.status],
      statusReason: x.r.statusReason,
      version: x.r.version,
      openRuns: open.get(x.r.id) ?? 0,
    }));
  }

  async list(companyId: string, input: { status?: unknown; kind?: unknown; cursor?: unknown }): Promise<{ rows: RiderView[]; nextCursor: string | null }> {
    const status = typeof input.status === 'string' && (RIDER_STATUSES as readonly string[]).includes(input.status) ? (input.status as RiderStatus) : null;
    const kind = isRiderKind(input.kind) ? input.kind : null;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const ordered = await this.db
      .select({ id: deliveryRiders.id, createdAtText: sql<string>`${deliveryRiders.createdAt}::text` })
      .from(deliveryRiders)
      .where(and(eq(deliveryRiders.companyId, companyId), status === null ? undefined : eq(deliveryRiders.status, status), kind === null ? undefined : eq(deliveryRiders.kind, kind), after === null ? undefined : sql`(${deliveryRiders.createdAt}, ${deliveryRiders.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`))
      .orderBy(desc(deliveryRiders.createdAt), desc(deliveryRiders.id))
      .limit(PAGE + 1);
    const page = ordered.slice(0, PAGE);
    const views = page.length === 0 ? [] : await this.rowsFor(this.db, [eq(deliveryRiders.companyId, companyId), inArray(deliveryRiders.id, page.map((p) => p.id))], PAGE);
    const last = page[page.length - 1];
    return { rows: views, nextCursor: ordered.length > PAGE && last !== undefined ? encodeCursor({ k: last.createdAtText, id: last.id }) : null };
  }

  /** A rider who may be given a run now, or null: riding, on a kind still used, with a live account. */
  async carrier(db: Tx | DrizzleDb, companyId: string, riderId: string): Promise<{ id: string; name: string } | null> {
    const [row] = await db.select({ r: deliveryRiders, accountOn: users.isActive, accountStatus: users.status }).from(deliveryRiders).innerJoin(users, eq(users.id, deliveryRiders.userId)).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, companyId)));
    if (row === undefined || !row.accountOn || row.accountStatus !== 'active') return null;
    const kinds = await this.settingsIn(db, companyId);
    return mayCarry(row.r, kinds) ? { id: row.r.id, name: row.r.name } : null;
  }

  /**
   * Who is using the rider app: the person's own rider row, if they are riding, on a kind the company still uses, with an account
   * still switched on (and, for staff, still a member of staff). Null for anyone else. Never takes an id from the browser.
   */
  async forUser(userId: string): Promise<RiderSelf | null> {
    const rows = await this.db
      .select({ r: deliveryRiders, role: users.role, accountOn: users.isActive, accountStatus: users.status })
      .from(deliveryRiders)
      .innerJoin(users, eq(users.id, deliveryRiders.userId))
      .where(and(eq(deliveryRiders.userId, userId), eq(deliveryRiders.status, 'active')))
      .orderBy(desc(deliveryRiders.createdAt))
      .limit(5);
    for (const row of rows) {
      if (!row.accountOn || row.accountStatus !== 'active') continue;
      const kinds = await this.settings(row.r.companyId);
      if (!mayCarry(row.r, kinds)) continue;
      if (row.r.kind === 'staff' && !(await this.isStaffRole(this.db, row.role))) continue;
      if (row.r.kind === 'separate' && row.role !== RIDER_ROLE) continue;
      return { riderId: row.r.id, companyId: row.r.companyId, userId, name: row.r.name, kind: row.r.kind, phone: row.r.phone };
    }
    return null;
  }
}
