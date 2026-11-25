import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, salesReps, salesRoutes, users } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { isId, readReason, readRep, REP_STATUSES, type RepMode, type RepStatus } from '@/lib/van-sales/people';
import { afterCursor, matching, PAGE_SIZE, pageOf, searchText, type PageInput } from '@/server/domains/settings/paging';
import { constraintOf, VanSalesError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface RepView {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  homeBranchId: string | null;
  homeBranchName: string | null;
  modes: RepMode[];
  maxDiscountPercent: number;
  maxCreditPerDay: number;
  mayOverridePrice: boolean;
  maySellOnCredit: boolean;
  status: RepStatus;
  statusReason: string | null;
  version: number;
}

export type RepFilter = RepStatus | 'all';
export interface RepPageInput extends PageInput {
  status?: RepFilter;
}

/** Staff who may be given the work of a rep: signed up, active, and of a staff role. */
export const STAFF_SQL = sql`(${users.role} = 'super_admin' OR EXISTS (SELECT 1 FROM roles r WHERE r.key = ${users.role} AND r.is_staff AND r.is_active))`;

/**
 * Sales reps (docs/architecture/van-sales.md §4.1): staff who sell outside, with the modes they do and the limits they hold on their
 * own. A rep who leaves is ended, never deleted, so the days they worked keep their name. Changes use a version and are in the decision log.
 */
export class RepService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  private select() {
    return this.db
      .select({ r: salesReps, email: users.email, homeBranchName: branches.name })
      .from(salesReps)
      .innerJoin(users, eq(users.id, salesReps.userId))
      .leftJoin(branches, eq(branches.id, salesReps.homeBranchId));
  }

  private view(x: Awaited<ReturnType<RepService['select']>>[number]): RepView {
    const r = x.r;
    return {
      id: r.id,
      userId: r.userId,
      name: r.name,
      email: x.email,
      phone: r.phone,
      homeBranchId: r.homeBranchId,
      homeBranchName: x.homeBranchName,
      modes: r.modes.filter((m): m is RepMode => m === 'van_sell' || m === 'pre_sell'),
      maxDiscountPercent: Number(r.maxDiscountPercent),
      maxCreditPerDay: Number(r.maxCreditPerDay),
      mayOverridePrice: r.mayOverridePrice,
      maySellOnCredit: r.maySellOnCredit,
      status: REP_STATUSES.find((s) => s === r.status) ?? 'active',
      statusReason: r.statusReason,
      version: r.version,
    };
  }

  async page(companyId: string, input: RepPageInput): Promise<{ rows: RepView[]; nextCursor: string | null }> {
    const status = input.status ?? 'active';
    const rows = await this.select()
      .where(and(eq(salesReps.companyId, companyId), status === 'all' ? undefined : eq(salesReps.status, status), matching(searchText(input), [salesReps.name, users.email, salesReps.phone]), afterCursor(input.cursor, salesReps.name, salesReps.id)))
      .orderBy(asc(salesReps.name), asc(salesReps.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (x) => ({ k: x.r.name, id: x.r.id }));
    return { rows: page.rows.map((x) => this.view(x)), nextCursor: page.nextCursor };
  }

  async get(companyId: string, id: string): Promise<RepView> {
    if (!isId(id)) throw new VanSalesError('That sales rep could not be found.');
    const [row] = await this.select().where(and(eq(salesReps.companyId, companyId), eq(salesReps.id, id))).limit(1);
    if (row === undefined) throw new VanSalesError('That sales rep could not be found.');
    return this.view(row);
  }

  async counts(companyId: string): Promise<Record<RepStatus, number>> {
    const rows = await this.db.select({ status: salesReps.status, n: sql<number>`count(*)::int` }).from(salesReps).where(eq(salesReps.companyId, companyId)).groupBy(salesReps.status);
    const n = (s: RepStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    return { active: n('active'), paused: n('paused'), ended: n('ended') };
  }

  private async checkBranch(tx: Tx, companyId: string, branchId: string | null): Promise<void> {
    if (branchId === null) return;
    const [b] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, companyId), eq(branches.isActive, true))).limit(1);
    if (b === undefined) throw new VanSalesError('Choose one of the company\'s branches that is in use.');
  }

  async create(companyId: string, actor: Actor, raw: unknown): Promise<RepView> {
    const read = readRep(raw, true);
    if (!read.ok) throw new VanSalesError(read.error);
    const rep = read.rep;
    const id = await this.db
      .transaction(async (tx) => {
        const [person] = await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(eq(users.id, rep.userId ?? ''), eq(users.status, 'active'), eq(users.isActive, true), STAFF_SQL))
          .limit(1);
        if (person === undefined) throw new VanSalesError('Choose a member of staff whose account is in use.');
        await this.checkBranch(tx, companyId, rep.homeBranchId);
        const [made] = await tx
          .insert(salesReps)
          .values({
            companyId,
            userId: person.id,
            name: person.name,
            phone: rep.phone,
            homeBranchId: rep.homeBranchId,
            modes: rep.modes,
            maxDiscountPercent: String(rep.limits.maxDiscountPercent),
            maxCreditPerDay: rep.limits.maxCreditPerDay.toFixed(2),
            mayOverridePrice: rep.limits.mayOverridePrice,
            maySellOnCredit: rep.limits.maySellOnCredit,
          })
          .returning({ id: salesReps.id });
        if (made === undefined) throw new VanSalesError('The sales rep could not be saved. Please try again.');
        await this.decisions.record({ companyId, actor, subject: { type: 'sales_rep', id: made.id }, action: 'rep.created', reason: { text: person.name }, inputs: {}, outcome: { modes: rep.modes, ...rep.limits } }, tx);
        return made.id;
      })
      .catch((error: unknown) => {
        if (constraintOf(error) === 'sales_reps_company_user_uidx') throw new VanSalesError('That person is already a sales rep.');
        throw error;
      });
    return await this.get(companyId, id);
  }

  private async locked(tx: Tx, companyId: string, id: string, expectedVersion: unknown) {
    if (!isId(id)) throw new VanSalesError('That sales rep could not be found.');
    const [row] = await tx.select().from(salesReps).where(and(eq(salesReps.companyId, companyId), eq(salesReps.id, id))).limit(1).for('update');
    if (row === undefined) throw new VanSalesError('That sales rep could not be found.');
    if (expectedVersion !== row.version) throw new VanSalesError('Someone else changed this sales rep while you were looking at them. Reload the page to see the latest.');
    return row;
  }

  /** Changes how to reach them, their branch, the modes they do and their limits. */
  async update(companyId: string, actor: Actor, id: string, raw: unknown, expectedVersion: unknown): Promise<RepView> {
    const read = readRep(raw, false);
    if (!read.ok) throw new VanSalesError(read.error);
    const rep = read.rep;
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, companyId, id, expectedVersion);
      if (row.status === 'ended') throw new VanSalesError('This sales rep has ended. Put them back to work before changing them.');
      await this.checkBranch(tx, companyId, rep.homeBranchId);
      await tx
        .update(salesReps)
        .set({ phone: rep.phone, homeBranchId: rep.homeBranchId, modes: rep.modes, maxDiscountPercent: String(rep.limits.maxDiscountPercent), maxCreditPerDay: rep.limits.maxCreditPerDay.toFixed(2), mayOverridePrice: rep.limits.mayOverridePrice, maySellOnCredit: rep.limits.maySellOnCredit, version: row.version + 1, updatedAt: new Date() })
        .where(eq(salesReps.id, row.id));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'sales_rep', id: row.id },
          action: 'rep.changed',
          reason: { text: row.name },
          inputs: { modes: row.modes, maxDiscountPercent: Number(row.maxDiscountPercent), maxCreditPerDay: Number(row.maxCreditPerDay), mayOverridePrice: row.mayOverridePrice, maySellOnCredit: row.maySellOnCredit },
          outcome: { modes: rep.modes, ...rep.limits },
        },
        tx,
      );
    });
    return await this.get(companyId, id);
  }

  /** Pauses or ends a rep (each with a reason) or puts them back to work. */
  async setStatus(companyId: string, actor: Actor, id: string, input: { status: unknown; reason?: unknown; expectedVersion: unknown }): Promise<RepView> {
    const status = REP_STATUSES.find((s) => s === input.status);
    if (status === undefined) throw new VanSalesError('Choose whether the rep is selling, paused or ended.');
    const why = status === 'active' ? null : readReason(input.reason);
    if (why !== null && !why.ok) throw new VanSalesError(why.error);
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, companyId, id, input.expectedVersion);
      if (row.status === status) throw new VanSalesError(`This sales rep is already ${status === 'active' ? 'selling' : status}.`);
      if (status === 'ended') {
        const [route] = await tx.select({ name: salesRoutes.name }).from(salesRoutes).where(and(eq(salesRoutes.defaultRepId, row.id), eq(salesRoutes.status, 'active'))).limit(1);
        if (route !== undefined) throw new VanSalesError(`${row.name} is the usual rep of the route ${route.name}. Choose another rep for that route first.`);
      }
      if (status === 'active') {
        const [person] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, row.userId), eq(users.status, 'active'), eq(users.isActive, true), STAFF_SQL)).limit(1);
        if (person === undefined) throw new VanSalesError('Their account is not in use, so they cannot sell. Switch the account on in Users first.');
      }
      await tx.update(salesReps).set({ status, statusReason: why?.reason ?? null, version: row.version + 1, updatedAt: new Date() }).where(eq(salesReps.id, row.id));
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_rep', id: row.id }, action: `rep.${status === 'active' ? 'resumed' : status}`, reason: { text: why?.reason ?? row.name }, inputs: { status: row.status }, outcome: { status } }, tx);
    });
    return await this.get(companyId, id);
  }
}
