import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { packageGroupEntries, packageGroupOrders } from '@/server/db/drizzle/schema';
import { cleanDay, cleanPersonName, cleanTitle, groupAcceptsChoices, groupCartLines, groupClosedReason, MAX_GROUP_ENTRIES } from '@/lib/group-order';
import { storedWords, type StoredPick } from './domain/package-shop';
import type { RawPick } from './domain/packages';
import type { PackageOrderService } from './package-order-service';
import type { PackageShopService, ShopBuilder } from './package-shop-service';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The most open groups one organiser can have at a time, so a link cannot be minted without end. */
export const MAX_OPEN_GROUPS = 20;

export interface GroupEntryView {
  id: string;
  personName: string;
  words: string;
  note: string;
}

export interface GroupView {
  id: string;
  productId: string;
  packageName: string;
  title: string;
  organiserName: string;
  forDate: string | null;
  closesAt: string | null;
  status: 'open' | 'closed' | 'cancelled';
  /** Choices can still be added or changed. */
  accepts: boolean;
  closedReason: string | null;
  isOrganiser: boolean;
  /** How many people have chosen. Only the organiser is shown who, and what. */
  entryCount: number;
  entries: GroupEntryView[];
  /** The builder for the package, while choices are taken. */
  builder: ShopBuilder | null;
}

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface GroupCart {
  /** What to put in the organiser's cart: today's option ids, with how many servings and the people behind each line. */
  lines: { picks: RawPick[]; servings: number; note: string; people: string[] }[];
  /** People whose choice cannot be made today, with why; the organiser sorts these out with them. */
  problems: { person: string; message: string }[];
}

/**
 * Group orders: an organiser (a signed-in customer) shares a link; each person chooses their own serving of a package; the organiser
 * puts everyone's choices in their cart and pays once, through the ordinary checkout (so every ordering rule, stock check and price
 * is the order's). The link's token and each person's secret are kept only as hashes.
 */
export class PackageGroupService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shop: PackageShopService,
    private readonly orders: PackageOrderService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(companyId: string, organiser: { customerId: string; name: string }, input: { productId: string; title: unknown; forDate: unknown; closesAt: unknown }): Promise<Outcome<{ token: string; id: string }>> {
    const builder = await this.shop.builder(companyId, input.productId);
    if (builder === null) return { ok: false, error: 'That is not a package that can be ordered.' };
    const [open] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(packageGroupOrders)
      .where(and(eq(packageGroupOrders.companyId, companyId), eq(packageGroupOrders.organiserCustomerId, organiser.customerId), eq(packageGroupOrders.status, 'open')));
    if (Number(open?.n ?? 0) >= MAX_OPEN_GROUPS) return { ok: false, error: `You already have ${String(MAX_OPEN_GROUPS)} open group orders. Close one before starting another.` };
    const forDate = input.forDate === undefined || input.forDate === null || input.forDate === '' ? null : cleanDay(input.forDate);
    if (input.forDate !== undefined && input.forDate !== null && input.forDate !== '' && forDate === null) return { ok: false, error: 'That is not a date.' };
    let closesAt: Date | null = null;
    if (input.closesAt !== undefined && input.closesAt !== null && input.closesAt !== '') {
      closesAt = typeof input.closesAt === 'string' ? new Date(input.closesAt) : null;
      if (closesAt === null || Number.isNaN(closesAt.getTime())) return { ok: false, error: 'That is not a time.' };
      if (closesAt.getTime() <= this.clock().getTime()) return { ok: false, error: 'The time for choosing must be in the future.' };
    }
    const token = randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(packageGroupOrders)
      .values({ companyId, packageProductId: input.productId, packageName: builder.package.name, tokenHash: sha256(token), title: cleanTitle(input.title), organiserCustomerId: organiser.customerId, organiserName: cleanPersonName(organiser.name) === '' ? 'The organiser' : cleanPersonName(organiser.name), forDate, closesAt })
      .returning({ id: packageGroupOrders.id });
    if (row === undefined) throw new Error('the group order was not saved');
    return { ok: true, token, id: row.id };
  }

  private async find(token: string) {
    const [group] = await this.db.select().from(packageGroupOrders).where(eq(packageGroupOrders.tokenHash, sha256(token))).limit(1);
    return group;
  }

  /** What a person opening the link sees. Only the organiser is shown the names and choices. */
  async view(token: string, viewerCustomerId: string | null): Promise<GroupView | null> {
    const group = await this.find(token);
    if (group === undefined) return null;
    const now = this.clock();
    const isOrganiser = viewerCustomerId !== null && viewerCustomerId === group.organiserCustomerId;
    const entries = await this.db.select().from(packageGroupEntries).where(eq(packageGroupEntries.groupId, group.id)).orderBy(packageGroupEntries.createdAt);
    const builder = groupAcceptsChoices(group, now) ? await this.shop.builder(group.companyId, group.packageProductId) : null;
    const unavailable = builder?.offered !== true;
    const closedReason = groupClosedReason(group, now) ?? (unavailable ? `${group.packageName} is not available right now.` : null);
    return {
      id: group.id,
      productId: group.packageProductId,
      packageName: group.packageName,
      title: group.title,
      organiserName: group.organiserName,
      forDate: group.forDate,
      closesAt: group.closesAt === null ? null : group.closesAt.toISOString(),
      status: group.status,
      accepts: closedReason === null,
      closedReason,
      isOrganiser,
      entryCount: entries.length,
      entries: isOrganiser ? entries.map((e) => ({ id: e.id, personName: e.personName, words: storedWords(e.picks), note: e.note })) : [],
      builder: closedReason === null ? builder : null,
    };
  }

  /** Checks one person's choice as an order would (choices, stock for a serving, the note), and gives what is kept. */
  private async check(companyId: string, productId: string, picks: RawPick[], note: string): Promise<Outcome<{ stored: StoredPick[]; key: string; note: string }>> {
    const prepared = await this.orders.prepare({ companyId, customerGroupId: null, signedIn: false, forDate: null, now: this.clock(), previewOnly: true }, [{ index: 0, productId, picks, servings: 1, note }]);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const line = prepared.lines[0];
    if (line === undefined) return { ok: false, error: 'That choice could not be checked.' };
    return { ok: true, stored: line.stored, key: line.key, note: line.note };
  }

  /** Adds a person's choice. They are given a secret, kept in their own browser, to change or withdraw it. */
  async addEntry(token: string, input: { name: unknown; picks: RawPick[]; note: string }): Promise<Outcome<{ entryId: string; secret: string }>> {
    const name = cleanPersonName(input.name);
    if (name === '') return { ok: false, error: 'Please tell us your name, so the organiser knows whose lunch it is.' };
    return await this.db.transaction(async (tx) => {
      const [group] = await tx.select().from(packageGroupOrders).where(eq(packageGroupOrders.tokenHash, sha256(token))).for('update').limit(1);
      if (group === undefined) return { ok: false, error: 'This link is not valid.' } as const;
      const closed = groupClosedReason(group, this.clock());
      if (closed !== null) return { ok: false, error: closed } as const;
      const [count] = await tx.select({ n: sql<string>`count(*)` }).from(packageGroupEntries).where(eq(packageGroupEntries.groupId, group.id));
      if (Number(count?.n ?? 0) >= MAX_GROUP_ENTRIES) return { ok: false, error: `This group order already has ${String(MAX_GROUP_ENTRIES)} people. Ask the organiser to start another.` } as const;
      const checked = await this.check(group.companyId, group.packageProductId, input.picks, input.note);
      if (!checked.ok) return checked;
      const secret = randomBytes(24).toString('base64url');
      const [row] = await tx
        .insert(packageGroupEntries)
        .values({ groupId: group.id, personName: name, picks: checked.stored, note: checked.note, selectionKey: checked.key, secretHash: sha256(secret) })
        .returning({ id: packageGroupEntries.id });
      if (row === undefined) throw new Error('the choice was not saved');
      return { ok: true, entryId: row.id, secret } as const;
    });
  }

  /** The person who made the choice (by their secret) changes it, while choices are taken. */
  async updateEntry(token: string, entryId: string, secret: string, input: { name: unknown; picks: RawPick[]; note: string }): Promise<Outcome<{ entryId: string }>> {
    const name = cleanPersonName(input.name);
    if (name === '') return { ok: false, error: 'Please tell us your name.' };
    const group = await this.find(token);
    if (group === undefined) return { ok: false, error: 'This link is not valid.' };
    const closed = groupClosedReason(group, this.clock());
    if (closed !== null) return { ok: false, error: closed };
    const entry = await this.ownEntry(group.id, entryId, secret);
    if (entry === null) return { ok: false, error: 'That choice is not yours to change.' };
    const checked = await this.check(group.companyId, group.packageProductId, input.picks, input.note);
    if (!checked.ok) return checked;
    await this.db.update(packageGroupEntries).set({ personName: name, picks: checked.stored, note: checked.note, selectionKey: checked.key, updatedAt: this.clock() }).where(eq(packageGroupEntries.id, entry.id));
    return { ok: true, entryId: entry.id };
  }

  private async ownEntry(groupId: string, entryId: string, secret: string) {
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) return null;
    const [entry] = await this.db.select().from(packageGroupEntries).where(and(eq(packageGroupEntries.id, entryId), eq(packageGroupEntries.groupId, groupId))).limit(1);
    return entry !== undefined && same(entry.secretHash, sha256(secret)) ? entry : null;
  }

  /** A person withdraws their own choice (with their secret), or the organiser removes anyone's. */
  async removeEntry(token: string, entryId: string, by: { secret: string } | { organiserCustomerId: string }): Promise<Outcome> {
    const group = await this.find(token);
    if (group === undefined) return { ok: false, error: 'This link is not valid.' };
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) return { ok: false, error: 'That choice was not found.' };
    if ('secret' in by) {
      const closed = groupClosedReason(group, this.clock());
      if (closed !== null) return { ok: false, error: closed };
      if ((await this.ownEntry(group.id, entryId, by.secret)) === null) return { ok: false, error: 'That choice is not yours to withdraw.' };
    } else if (by.organiserCustomerId !== group.organiserCustomerId) {
      return { ok: false, error: 'Only the organiser can remove someone else\'s choice.' };
    }
    await this.db.delete(packageGroupEntries).where(and(eq(packageGroupEntries.id, entryId), eq(packageGroupEntries.groupId, group.id)));
    return { ok: true };
  }

  /** The organiser opens, closes or cancels the group. */
  async setStatus(token: string, organiserCustomerId: string, status: 'open' | 'closed' | 'cancelled'): Promise<Outcome> {
    const group = await this.find(token);
    if (group?.organiserCustomerId !== organiserCustomerId) return { ok: false, error: 'This group order is not yours.' };
    if (group.status === 'cancelled') return { ok: false, error: 'A cancelled group order cannot be opened again.' };
    await this.db.update(packageGroupOrders).set({ status, updatedAt: this.clock() }).where(eq(packageGroupOrders.id, group.id));
    return { ok: true };
  }

  /**
   * Everyone's choices as cart lines for the organiser, found again against today's package (identical choices become one line with
   * that many servings). Choosing stops: the group is closed. A choice that cannot be made today is named, not silently dropped.
   */
  async forCart(token: string, organiserCustomerId: string): Promise<Outcome<{ cart: GroupCart }>> {
    const group = await this.find(token);
    if (group?.organiserCustomerId !== organiserCustomerId) return { ok: false, error: 'This group order is not yours.' };
    if (group.status === 'cancelled') return { ok: false, error: 'This group order was cancelled.' };
    const entries = await this.db.select().from(packageGroupEntries).where(eq(packageGroupEntries.groupId, group.id)).orderBy(packageGroupEntries.createdAt);
    if (entries.length === 0) return { ok: false, error: 'Nobody has chosen yet.' };
    const problems: GroupCart['problems'] = [];
    const usable: { selectionKey: string; personName: string; picks: RawPick[]; note: string }[] = [];
    for (const entry of entries) {
      const resolved = await this.orders.resolve(group.companyId, [{ productId: group.packageProductId, stored: entry.picks }]);
      if (!resolved.ok) problems.push({ person: entry.personName, message: resolved.error });
      else usable.push({ selectionKey: entry.selectionKey, personName: entry.personName, picks: resolved.picks[0] ?? [], note: entry.note });
    }
    await this.db.update(packageGroupOrders).set({ status: 'closed', updatedAt: this.clock() }).where(eq(packageGroupOrders.id, group.id));
    const lines = groupCartLines(usable).map((l) => ({ picks: l.picks, servings: l.servings, note: l.note, people: l.people }));
    return { ok: true, cart: { lines, problems } };
  }

  /** The organiser's own groups, newest first. */
  async mine(companyId: string, organiserCustomerId: string, limit = 20): Promise<{ title: string; packageName: string; status: string; createdAt: string }[]> {
    const rows = await this.db
      .select({ title: packageGroupOrders.title, packageName: packageGroupOrders.packageName, status: packageGroupOrders.status, createdAt: packageGroupOrders.createdAt })
      .from(packageGroupOrders)
      .where(and(eq(packageGroupOrders.companyId, companyId), eq(packageGroupOrders.organiserCustomerId, organiserCustomerId)))
      .orderBy(desc(packageGroupOrders.createdAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }
}
