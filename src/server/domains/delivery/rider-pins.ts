import { createHmac, randomInt } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { hash, verify } from '@node-rs/bcrypt';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveryRiders, riderPins, users } from '@/server/db/drizzle/schema';
import { LOCK_AFTER, generatePin, isPinShape, lockWords, lockedUntil, normalizePhone, phoneWords, pinProblem } from '@/lib/rider-pin';
import { mayCarry } from '@/lib/delivery-rider';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';
import { RIDER_ROLE, type DeliveryRiders, type RiderSelf } from './riders';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST = 10;

/** What the office sees of a rider's PIN. The PIN itself is never here. */
export interface PinStatus {
  phone: string;
  phoneWords: string;
  /** Handed out by the office and not yet replaced by the rider's own. */
  temporary: boolean;
  locked: { until: string; words: string } | null;
  failedAttempts: number;
  lastSignedInAt: string | null;
}

export type PinCheck =
  | { ok: true; userId: string; riderId: string; mustChange: boolean }
  | { ok: false; reason: 'wrong' }
  | { ok: false; reason: 'locked'; words: string };

/** Thrown inside a transaction so a refusal rolls it back. */
class Refused extends Error {
  constructor(
    readonly reason: DocRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Signing in to the rider app with a phone number and a PIN, for riders with an account of their own. The office hands out a temporary PIN
 * (shown once, never kept); the rider must replace it with their own at the first sign-in. Six digits are few, so everything is built to make
 * guessing useless: the PIN is hashed with a secret of the server's own, wrong tries are counted under a row lock (guesses made at the same
 * moment cannot get past the count), five wrong tries in a row shut the rider out for a growing time, the sign-in is also limited by address
 * and by number, and a member of staff can never sign in this way. Whether a number is a rider at all is not told to someone who guesses.
 */
export class RiderPins {
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly riders: Pick<DeliveryRiders, 'settings'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private secret(): string {
    const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';
    if (s === '') throw new Error('AUTH_SECRET is required.');
    return s;
  }

  /** The PIN made one with the rider and the server's secret, so the same PIN gives different hashes and a copy of the table cannot be tried offline without the secret. */
  private async hashPin(riderId: string, pin: string): Promise<string> {
    return await hash(createHmac('sha256', this.secret()).update(`${riderId}:${pin}`).digest('hex'), COST);
  }

  private async matches(riderId: string, pin: string, stored: string): Promise<boolean> {
    return await verify(createHmac('sha256', this.secret()).update(`${riderId}:${pin}`).digest('hex'), stored);
  }

  /** A hash to compare against when the number is unknown, so an unknown number takes as long as a known one. */
  private async wasteTime(pin: string): Promise<void> {
    this.dummy ??= hash('not-a-real-rider', COST);
    await verify(pin, await this.dummy).catch(() => false);
  }

  private view(r: typeof riderPins.$inferSelect, now: Date): PinStatus {
    const locked = r.lockedUntil !== null && r.lockedUntil > now ? { until: r.lockedUntil.toISOString(), words: lockWords(r.lockedUntil, now) } : null;
    return { phone: r.phone, phoneWords: phoneWords(r.phone), temporary: r.mustChange, locked, failedAttempts: r.failedAttempts, lastSignedInAt: r.lastSignedInAt === null ? null : r.lastSignedInAt.toISOString() };
  }

  /** When the PIN of this user's rider was set, in milliseconds: a session made with the PIN lasts only while this stays the same. Null when they have none. */
  async stampFor(userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ at: riderPins.setAt })
      .from(riderPins)
      .innerJoin(deliveryRiders, eq(deliveryRiders.id, riderPins.riderId))
      .where(eq(deliveryRiders.userId, userId))
      .limit(1);
    return row === undefined ? null : row.at.getTime();
  }

  /** The PIN state of these riders, in one read. A rider with none is not in the map. */
  async statusFor(companyId: string, riderIds: string[]): Promise<Map<string, PinStatus>> {
    const out = new Map<string, PinStatus>();
    if (riderIds.length === 0) return out;
    const now = this.clock();
    const rows = await this.db.select().from(riderPins).where(and(eq(riderPins.companyId, companyId), inArray(riderPins.riderId, riderIds)));
    for (const r of rows) out.set(r.riderId, this.view(r, now));
    return out;
  }

  /** Whether this rider may sign in with a PIN at all: still riding, with an account made for riding, on a kind the company uses. */
  private async eligible(db: DrizzleDb | Tx, riderId: string): Promise<{ ok: true; userId: string; companyId: string } | { ok: false }> {
    const [row] = await db
      .select({ r: deliveryRiders, role: users.role, on: users.isActive, status: users.status })
      .from(deliveryRiders)
      .innerJoin(users, eq(users.id, deliveryRiders.userId))
      .where(eq(deliveryRiders.id, riderId));
    if (row?.r.kind !== 'separate' || row.role !== RIDER_ROLE || !row.on || row.status !== 'active') return { ok: false };
    if (!mayCarry(row.r, await this.riders.settings(row.r.companyId))) return { ok: false };
    return { ok: true, userId: row.r.userId, companyId: row.r.companyId };
  }

  /**
   * Gives a rider a PIN, or a new one if they had one: six random digits, shown once to the office and never kept, which the rider must
   * replace with their own at the first sign-in. Clears any lock. Only a rider with an account of their own; the number is the rider's alone.
   */
  async issue(actor: DocActor, riderId: string): Promise<DocResult<{ pin: string; status: PinStatus }>> {
    if (!UUID.test(riderId)) return fail('not_found', 'That rider could not be found.');
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<{ pin: string; status: PinStatus }>> => {
        const [rider] = await tx.select().from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, actor.companyId))).for('update');
        if (rider === undefined) throw new Refused('not_found', 'That rider could not be found.');
        if (rider.kind !== 'separate') throw new Refused('not_allowed', 'A member of staff signs in with their own account. A PIN is for riders with an account of their own.');
        if (rider.status === 'ended') throw new Refused('not_allowed', 'This rider has left.');
        const phone = normalizePhone(rider.phone);
        if (phone === null) throw new Refused('bad_input', 'Give the rider a Kenyan mobile phone number first (for example 0712 345 678). They sign in with it.');
        const [taken] = await tx.select({ riderId: riderPins.riderId }).from(riderPins).where(eq(riderPins.phone, phone));
        if (taken !== undefined && taken.riderId !== riderId) throw new Refused('conflict', 'Another rider already signs in with that phone number.');
        const ok = await this.eligible(tx, riderId);
        if (!ok.ok) throw new Refused('not_allowed', 'This rider cannot be given a PIN. Check that their kind of account is switched on in the rider settings.');
        const pin = generatePin((below) => randomInt(below), phone);
        const pinHash = await this.hashPin(riderId, pin);
        const set = { phone, pinHash, mustChange: true, failedAttempts: 0, lastFailedAt: null, lockedUntil: null, setBy: actor.userId, setAt: this.clock() };
        const had = await tx.update(riderPins).set(set).where(eq(riderPins.riderId, riderId)).returning({ id: riderPins.riderId });
        if (had.length === 0) await tx.insert(riderPins).values({ riderId, companyId: actor.companyId, ...set });
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: had.length === 0 ? 'rider.pin_issued' : 'rider.pin_reissued', actor: { type: 'user', id: actor.userId } }, tx);
        const [fresh] = await tx.select().from(riderPins).where(eq(riderPins.riderId, riderId));
        if (fresh === undefined) throw new Error('The PIN could not be read back.');
        return { ok: true, data: { pin, status: this.view(fresh, this.clock()) } };
      });
    } catch (error) {
      if (error instanceof Refused) return fail(error.reason, error.message);
      throw error;
    }
  }

  /** Takes away a rider's PIN sign-in. */
  async remove(actor: DocActor, riderId: string): Promise<DocResult<{ done: true }>> {
    if (!UUID.test(riderId)) return fail('not_found', 'That rider could not be found.');
    return await this.db.transaction(async (tx): Promise<DocResult<{ done: true }>> => {
      const gone = await tx.delete(riderPins).where(and(eq(riderPins.riderId, riderId), eq(riderPins.companyId, actor.companyId))).returning({ id: riderPins.riderId });
      if (gone.length === 0) return fail('not_found', 'This rider has no PIN.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.pin_removed', actor: { type: 'user', id: actor.userId }, reason: { text: 'Turned off by the office' } }, tx);
      return { ok: true, data: { done: true } };
    });
  }

  /** Lets a shut-out rider try again now. */
  async unlock(actor: DocActor, riderId: string): Promise<DocResult<{ status: PinStatus }>> {
    if (!UUID.test(riderId)) return fail('not_found', 'That rider could not be found.');
    return await this.db.transaction(async (tx): Promise<DocResult<{ status: PinStatus }>> => {
      const done = await tx.update(riderPins).set({ failedAttempts: 0, lastFailedAt: null, lockedUntil: null }).where(and(eq(riderPins.riderId, riderId), eq(riderPins.companyId, actor.companyId))).returning();
      const row = done[0];
      if (row === undefined) return fail('not_found', 'This rider has no PIN.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_rider', id: riderId }, action: 'rider.pin_unlocked', actor: { type: 'user', id: actor.userId } }, tx);
      return { ok: true, data: { status: this.view(row, this.clock()) } };
    });
  }

  /**
   * Checks a phone number and PIN at sign-in. The row is locked while the PIN is compared and the count is changed, so many guesses at
   * once are counted one after another. Every wrong answer is the same ("wrong"), whether the number is a rider's or not; only a rider
   * who has been shut out is told how long to wait.
   */
  async verify(phoneRaw: unknown, pin: unknown): Promise<PinCheck> {
    const phone = normalizePhone(phoneRaw);
    if (phone === null || !isPinShape(pin)) {
      await this.wasteTime(typeof pin === 'string' ? pin : '');
      return { ok: false, reason: 'wrong' };
    }
    const now = this.clock();
    const outcome = await this.db.transaction(async (tx): Promise<PinCheck | 'unknown'> => {
      const [row] = await tx.select().from(riderPins).where(eq(riderPins.phone, phone)).for('update');
      if (row === undefined) return 'unknown';
      if (row.lockedUntil !== null && row.lockedUntil > now) return { ok: false, reason: 'locked', words: lockWords(row.lockedUntil, now) };
      const right = await this.matches(row.riderId, pin, row.pinHash);
      const ok = right ? await this.eligible(tx, row.riderId) : { ok: false as const };
      if (right && ok.ok) {
        await tx.update(riderPins).set({ failedAttempts: 0, lastFailedAt: null, lockedUntil: null, lastSignedInAt: now }).where(eq(riderPins.riderId, row.riderId));
        return { ok: true, userId: ok.userId, riderId: row.riderId, mustChange: row.mustChange };
      }
      // A right PIN for a rider who may no longer ride is answered like a wrong one and is not counted against them.
      if (right) return { ok: false, reason: 'wrong' };
      const failed = row.failedAttempts + 1;
      const until = lockedUntil(failed, now);
      await tx.update(riderPins).set({ failedAttempts: failed, lastFailedAt: now, lockedUntil: until }).where(eq(riderPins.riderId, row.riderId));
      if (until !== null && failed === LOCK_AFTER) await this.decisions.record({ companyId: row.companyId, subject: { type: 'delivery_rider', id: row.riderId }, action: 'rider.pin_locked', actor: { type: 'system', id: 'rider-sign-in' }, inputs: { failed } }, tx);
      return until === null ? { ok: false, reason: 'wrong' } : { ok: false, reason: 'locked', words: lockWords(until, now) };
    });
    if (outcome === 'unknown') {
      await this.wasteTime(pin);
      return { ok: false, reason: 'wrong' };
    }
    return outcome;
  }

  /**
   * The rider chooses their own PIN. They must give the one they have now (so a phone left unlocked cannot change it), the new one twice
   * the same, and it must pass the rules and differ from the old. A wrong current PIN is counted like a wrong sign-in.
   */
  async change(self: RiderSelf, input: { current?: unknown; next?: unknown; confirm?: unknown }): Promise<DocResult<{ phone: string }>> {
    const current = typeof input.current === 'string' ? input.current : '';
    const next = typeof input.next === 'string' ? input.next : '';
    if (next !== input.confirm) return fail('bad_input', 'The two new PINs are not the same.');
    const now = this.clock();
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<{ phone: string }>> => {
        const [row] = await tx.select().from(riderPins).where(eq(riderPins.riderId, self.riderId)).for('update');
        if (row === undefined) throw new Refused('not_found', 'You do not sign in with a PIN.');
        if (row.lockedUntil !== null && row.lockedUntil > now) throw new Refused('not_allowed', `Too many wrong tries. Try again in ${lockWords(row.lockedUntil, now)}.`);
        if (!(await this.matches(row.riderId, current, row.pinHash))) {
          const failed = row.failedAttempts + 1;
          await tx.update(riderPins).set({ failedAttempts: failed, lastFailedAt: now, lockedUntil: lockedUntil(failed, now) }).where(eq(riderPins.riderId, row.riderId));
          return fail('bad_input', 'Your current PIN is not right.');
        }
        const problem = pinProblem(next, row.phone);
        if (problem !== null) throw new Refused('bad_input', problem);
        if (next === current) throw new Refused('bad_input', 'Choose a PIN different from the one you have now.');
        await tx.update(riderPins).set({ pinHash: await this.hashPin(row.riderId, next), mustChange: false, failedAttempts: 0, lastFailedAt: null, lockedUntil: null, setBy: self.userId, setAt: now }).where(eq(riderPins.riderId, row.riderId));
        await this.decisions.record({ companyId: row.companyId, subject: { type: 'delivery_rider', id: row.riderId }, action: 'rider.pin_changed', actor: { type: 'user', id: self.userId } }, tx);
        return { ok: true, data: { phone: row.phone } };
      });
    } catch (error) {
      if (error instanceof Refused) return fail(error.reason, error.message);
      throw error;
    }
  }
}
