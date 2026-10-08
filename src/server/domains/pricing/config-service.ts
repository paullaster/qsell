import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  currencies,
  customerGroupMembers,
  customerGroups,
  customers,
  decisionLog,
  priceListLines,
  priceLists,
  priceSpecificityWeights,
  products,
} from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { validateScopes, validateTiers, wouldTie, type RuleIssue } from './domain/rules';
import {
  DEFAULT_WEIGHTS,
  type PriceListKind,
  type QuantityMode,
  type Scopes,
  type SpecificityWeights,
  type Tier,
} from './domain/types';
import { afterCommit, withAfterCommit } from '@/server/kernel/after-commit';
import type { ApprovalEngine, Tx } from '@/server/kernel/approvals/engine';
import type { ParkedActions } from '@/server/kernel/approvals/parked-actions';
import type { PricingService } from './service';

export class PricingConfigError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'DUPLICATE_CODE'
      | 'INVALID'
      | 'NOT_EDITABLE'
      | 'LOCKED'
      | 'CONFLICT'
      | 'TOO_MANY',
    message: string,
    readonly issues: RuleIssue[] = [],
  ) {
    super(message);
    this.name = 'PricingConfigError';
  }
}

/** A change that was made now, or held for approval. */
export type Gated<T> = ({ pending: false } & T) | { pending: true; message: string };

export type ListRow = typeof priceLists.$inferSelect;
export type LineRow = typeof priceListLines.$inferSelect;
export type GroupRow = typeof customerGroups.$inferSelect;

export interface ListInput {
  code: string;
  name: string;
  description?: string | null;
  kind?: PriceListKind;
  currency: string;
  taxInclusive?: boolean;
  quantityMode?: QuantityMode;
  priority?: number;
  validFrom?: Date | null;
  validTo?: Date | null;
  scopes?: Scopes;
}

export interface LineInput {
  productId: string;
  price: number;
  tiers?: Tier[];
  floorPrice?: number | null;
  lockedUntil?: Date | null;
}

/** Most rows one call may change; bigger files are sent in parts so one request stays bounded. */
export const MAX_LINES_PER_CALL = 5000;
const INSERT_CHUNK = 1000;
/** A price may start now but not in the past: history stays exactly as it was. */
const CLOCK_GRACE_MS = 60_000;

type Why = ReasonInput;
const same = (a: number | null, b: number | null) => (a ?? null) === (b ?? null);
const sameTiers = (a: Tier[], b: Tier[]) =>
  a.length === b.length &&
  a.every((t, i) => t.fromQty === b[i]!.fromQty && t.price === b[i]!.price);

/** The price in force already is exactly what is being asked for (so sending it again changes nothing). */
const isSamePrice = (inForce: LineRow, input: LineInput, tiers: Tier[]) =>
  Number(inForce.price) === input.price &&
  same(inForce.floorPrice == null ? null : Number(inForce.floorPrice), input.floorPrice ?? null) &&
  sameTiers(
    (inForce.tiers ?? []).map((t) => ({ fromQty: Number(t.fromQty), price: Number(t.price) })),
    tiers,
  ) &&
  (inForce.lockedUntil?.getTime() ?? null) === (input.lockedUntil?.getTime() ?? null);

/**
 * Everything an administrator can change about pricing. Each change needs a reason from the
 * reason catalogue and is written to the decision log; prices are never edited in place, they are
 * replaced by a new effective-dated row, so any past sale can still be explained.
 */
export class PricingConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly pricing: PricingService,
    private readonly approvals: ApprovalEngine,
    private readonly gate: ParkedActions,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  // ── Price lists ──────────────────────────────────────────────────────────

  async listLists(companyId: string) {
    const rows = await this.db
      .select()
      .from(priceLists)
      .where(eq(priceLists.companyId, companyId))
      .orderBy(asc(priceLists.status), desc(priceLists.priority), asc(priceLists.code));
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ id: priceListLines.priceListId, n: count() })
      .from(priceListLines)
      .where(
        and(
          inArray(
            priceListLines.priceListId,
            rows.map((r) => r.id),
          ),
          isNull(priceListLines.validTo),
        ),
      )
      .groupBy(priceListLines.priceListId);
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((r) => ({ ...r, lineCount: byId.get(r.id) ?? 0 }));
  }

  async getList(companyId: string, id: string): Promise<ListRow> {
    const [row] = await this.db
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.companyId, companyId), eq(priceLists.id, id)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That price list does not exist.');
    return row;
  }

  /** Checks that the customers, groups and branches a list names exist in this company. */
  async checkScopeReferences(companyId: string, scopes: Scopes): Promise<RuleIssue[]> {
    const issues: RuleIssue[] = [];
    const missing = async (
      dimension: string,
      ids: string[],
      found: Promise<Array<{ id: string }>>,
    ) => {
      const have = new Set((await found).map((r) => r.id));
      const gone = ids.filter((i) => !have.has(i));
      if (gone.length)
        issues.push({
          path: `scopes.${dimension}`,
          message: `${gone.length} ${dimension.replace('_', ' ')}${gone.length === 1 ? '' : 's'} no longer exist${gone.length === 1 ? 's' : ''}.`,
        });
    };
    const ids = (d: keyof Scopes) => scopes[d]?.values ?? [];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const bad = (d: keyof Scopes) => ids(d).some((v) => !UUID.test(v));
    if (ids('customer').length) {
      if (bad('customer')) issues.push({ path: 'scopes.customer', message: 'Unknown customer.' });
      else
        await missing(
          'customer',
          ids('customer'),
          this.db
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.companyId, companyId), inArray(customers.id, ids('customer')))),
        );
    }
    if (ids('customer_group').length) {
      if (bad('customer_group'))
        issues.push({ path: 'scopes.customer_group', message: 'Unknown customer group.' });
      else
        await missing(
          'customer_group',
          ids('customer_group'),
          this.db
            .select({ id: customerGroups.id })
            .from(customerGroups)
            .where(
              and(
                eq(customerGroups.companyId, companyId),
                inArray(customerGroups.id, ids('customer_group')),
              ),
            ),
        );
    }
    if (ids('branch').length) {
      if (bad('branch')) issues.push({ path: 'scopes.branch', message: 'Unknown branch.' });
      else
        await missing(
          'branch',
          ids('branch'),
          this.db
            .select({ id: branches.id })
            .from(branches)
            .where(inArray(branches.id, ids('branch'))),
        );
    }
    return issues;
  }

  private async assertCurrency(code: string) {
    const [c] = await this.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(and(eq(currencies.code, code), eq(currencies.isEnabled, true)))
      .limit(1);
    if (!c) throw new PricingConfigError('INVALID', `${code} is not an enabled currency.`);
  }

  private normaliseCode(raw: string) {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
      throw new PricingConfigError(
        'INVALID',
        'The code can use letters, numbers, "-" and "_" (up to 40).',
      );
    }
    return code;
  }

  async createList(companyId: string, input: ListInput, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    const code = this.normaliseCode(input.code);
    if (!input.name?.trim()) throw new PricingConfigError('INVALID', 'Give the price list a name.');
    await this.assertCurrency(input.currency);
    const scopes = input.scopes ?? {};
    const issues = [
      ...validateScopes(scopes),
      ...(await this.checkScopeReferences(companyId, scopes)),
    ];
    const validFrom = input.validFrom ?? new Date();
    if (input.validTo && input.validTo <= validFrom)
      issues.push({ path: 'validTo', message: 'The end date must be after the start date.' });
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);
    const [dup] = await this.db
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(and(eq(priceLists.companyId, companyId), eq(priceLists.code, code)))
      .limit(1);
    if (dup) throw new PricingConfigError('DUPLICATE_CODE', `A price list ${code} already exists.`);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(priceLists)
        .values({
          companyId,
          code,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          kind: input.kind ?? 'list',
          currency: input.currency,
          taxInclusive: input.taxInclusive ?? true,
          quantityMode: input.quantityMode ?? 'all_units',
          priority: input.priority ?? 0,
          validFrom,
          validTo: input.validTo ?? null,
          scopes,
          createdBy: actor.id ?? 'system',
        })
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_list', id: row!.id },
          action: 'pricing.list_created',
          reason: why,
          to: 'draft',
          outcome: { code, currency: row!.currency, kind: row!.kind, scopes },
        },
        tx,
      );
      return row!;
    });
  }

  /**
   * Changes how a list behaves. Each change adds a version. On a list in force this changes
   * live prices, so the same checks as activation run again.
   */
  /** What a header change would do, and everything that can be refused about it, before it is held or written. */
  private async planListUpdate(
    companyId: string,
    id: string,
    patch: Partial<Omit<ListInput, 'code' | 'currency' | 'kind'>>,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    const current = await this.getList(companyId, id);
    if (current.status === 'retired')
      throw new PricingConfigError('NOT_EDITABLE', 'A retired price list cannot be changed.');
    if (current.approvalStatus === 'pending')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'This price list is waiting for approval. Cancel the request before changing it.',
      );
    const next = {
      name: patch.name?.trim() ?? current.name,
      description:
        patch.description === undefined ? current.description : patch.description?.trim() || null,
      taxInclusive: patch.taxInclusive ?? current.taxInclusive,
      quantityMode: patch.quantityMode ?? current.quantityMode,
      priority: patch.priority ?? current.priority,
      validFrom: patch.validFrom ?? current.validFrom,
      validTo: patch.validTo === undefined ? current.validTo : patch.validTo,
      scopes: patch.scopes ?? current.scopes,
    };
    if (!next.name) throw new PricingConfigError('INVALID', 'Give the price list a name.');
    const issues = validateScopes(next.scopes);
    if (patch.scopes) issues.push(...(await this.checkScopeReferences(companyId, next.scopes)));
    if (next.validTo && next.validTo <= next.validFrom)
      issues.push({ path: 'validTo', message: 'The end date must be after the start date.' });
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);
    if (current.status === 'active') {
      const ties = await this.findTies(companyId, { ...current, ...next });
      if (ties.length) throw new PricingConfigError('CONFLICT', ties[0]!.message, ties);
    }
    const changed = Object.entries(next).filter(
      ([k, v]) => JSON.stringify(v) !== JSON.stringify((current as Record<string, unknown>)[k]),
    );
    return { why, current, next, changed };
  }

  async updateList(
    companyId: string,
    id: string,
    patch: Partial<Omit<ListInput, 'code' | 'currency' | 'kind'>>,
    actor: Actor,
    reason: Why,
    writer?: Tx,
  ) {
    const { why, current, next, changed } = await this.planListUpdate(companyId, id, patch, reason);
    if (changed.length === 0) return current;

    const row = await this.inTx(writer, companyId, async (tx) => {
      const [updated] = await tx
        .update(priceLists)
        .set({ ...next, version: current.version + 1, updatedAt: new Date() })
        .where(eq(priceLists.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_list', id },
          action: 'pricing.list_changed',
          reason: why,
          from: `v${current.version}`,
          to: `v${current.version + 1}`,
          inputs: Object.fromEntries(
            changed.map(([k]) => [k, (current as Record<string, unknown>)[k]]),
          ),
          outcome: Object.fromEntries(changed),
        },
        tx,
      );
      return updated!;
    });
    return row;
  }

  /** Runs a change in the caller's transaction (an approval releasing it) or in its own; the cache is cleared once it has committed. */
  private async inTx<T>(writer: Tx | undefined, companyId: string, fn: (tx: Tx) => Promise<T>) {
    if (writer) {
      const result = await fn(writer);
      afterCommit(writer, () => this.pricing.invalidate(companyId));
      return result;
    }
    const result = await this.db.transaction(fn);
    this.pricing.invalidate(companyId);
    return result;
  }

  // ── Changes to a list in force, with approval ───────────────────────────

  /**
   * Sets prices. On a list in force this may need approval: the facts approvers' conditions look at
   * are worked out here (how many prices change, the biggest rise and cut), and if a workflow
   * applies the change is held and applied when it is approved. A draft list is never held.
   */
  async setLinesGated(
    companyId: string,
    id: string,
    rows: LineInput[],
    actor: { type: 'user'; id: string },
    reason: Why,
    opts: { validFrom?: Date; overrideLock?: boolean } = {},
  ): Promise<Gated<Awaited<ReturnType<PricingConfigService['setLines']>>>> {
    const { why, list, now, start, byProduct, ids } = await this.checkLines(
      companyId,
      id,
      rows,
      reason,
      opts,
    );
    const direct = async () => ({
      pending: false as const,
      ...(await this.setLines(companyId, id, rows, actor, why, opts)),
    });
    if (list.status !== 'active') return direct();

    const open = await this.db
      .select()
      .from(priceListLines)
      .where(
        and(
          eq(priceListLines.priceListId, id),
          inArray(priceListLines.productId, ids),
          or(isNull(priceListLines.validTo), gt(priceListLines.validTo, start)),
        ),
      );
    let changed = 0;
    let added = 0;
    let largestRise = 0;
    let largestCut = 0;
    for (const [pid, input] of byProduct) {
      const tiers = [...(input.tiers ?? [])].sort((a, b) => a.fromQty - b.fromQty);
      const mine = open.filter((r) => r.productId === pid);
      const inForce = mine.find(
        (r) => r.validFrom <= start && (r.validTo === null || r.validTo > start),
      );
      if (inForce && mine.every((r) => r === inForce) && isSamePrice(inForce, input, tiers))
        continue;
      if (inForce?.lockedUntil && inForce.lockedUntil > now && !opts.overrideLock)
        throw new PricingConfigError(
          'LOCKED',
          `The price of ${pid} is locked until ${inForce.lockedUntil.toISOString().slice(0, 10)}.`,
        );
      changed++;
      if (!inForce) added++;
      else if (Number(inForce.price) > 0) {
        const pct = ((input.price - Number(inForce.price)) / Number(inForce.price)) * 100;
        largestRise = Math.max(largestRise, pct);
        largestCut = Math.max(largestCut, -pct);
      }
    }
    if (changed === 0) return direct();

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const outcome = await this.gate.gate(
      {
        trigger: 'price_list.live_change',
        companyId,
        requestedBy: actor.id,
        amount: 0,
        facts: {
          changedLines: changed,
          largestRisePercent: round1(largestRise),
          largestCutPercent: round1(largestCut),
          newProducts: added,
          removesPrices: false,
          headerChange: false,
          listKind: list.kind,
          listCode: list.code,
        },
        action: 'set_lines',
        payload: {
          listId: id,
          rows: rows.map((r) => ({ ...r, lockedUntil: r.lockedUntil?.toISOString() ?? null })),
          reason: why,
          validFrom: opts.validFrom?.toISOString() ?? null,
          overrideLock: opts.overrideLock === true,
        },
        summary: `Change ${changed.toLocaleString('en-KE')} live price${changed === 1 ? '' : 's'} on ${list.code} (${list.name}): ${added} new, largest rise ${round1(largestRise)}%, largest cut ${round1(largestCut)}%. Reason: ${why.code.replace(/_/g, ' ').toLowerCase()}${why.text ? ` — ${why.text}` : ''}.`,
      },
      direct,
    );
    return outcome.parked ? { pending: true, message: outcome.message } : outcome.value;
  }

  /** Stops pricing products on a list. On a list in force this may need approval. */
  async removeLinesGated(
    companyId: string,
    id: string,
    productIds: string[],
    actor: { type: 'user'; id: string },
    reason: Why,
    opts: { overrideLock?: boolean } = {},
  ): Promise<Gated<{ removed: number }>> {
    const why = await this.why(companyId, reason);
    const list = await this.getList(companyId, id);
    const direct = async () => ({
      pending: false as const,
      ...(await this.removeLines(companyId, id, productIds, actor, why, opts)),
    });
    if (list.status !== 'active') return direct();
    if (productIds.length === 0 || productIds.length > MAX_LINES_PER_CALL)
      throw new PricingConfigError('INVALID', 'Choose the products to remove.');
    const open = await this.db
      .select()
      .from(priceListLines)
      .where(
        and(
          eq(priceListLines.priceListId, id),
          inArray(priceListLines.productId, productIds),
          isNull(priceListLines.validTo),
        ),
      );
    const locked = open.find((r) => r.lockedUntil && r.lockedUntil > new Date());
    if (locked && !opts.overrideLock)
      throw new PricingConfigError('LOCKED', `The price of ${locked.productId} is locked.`);
    if (open.length === 0) return direct();
    const outcome = await this.gate.gate(
      {
        trigger: 'price_list.live_change',
        companyId,
        requestedBy: actor.id,
        amount: 0,
        facts: {
          changedLines: open.length,
          largestRisePercent: 0,
          largestCutPercent: 0,
          newProducts: 0,
          removesPrices: true,
          headerChange: false,
          listKind: list.kind,
          listCode: list.code,
        },
        action: 'remove_lines',
        payload: {
          listId: id,
          productIds,
          reason: why,
          overrideLock: opts.overrideLock === true,
        },
        summary: `Stop pricing ${open.length.toLocaleString('en-KE')} product${open.length === 1 ? '' : 's'} on ${list.code} (${list.name}); they fall back to other lists or the standard price. Reason: ${why.code.replace(/_/g, ' ').toLowerCase()}${why.text ? ` — ${why.text}` : ''}.`,
      },
      direct,
    );
    return outcome.parked ? { pending: true, message: outcome.message } : outcome.value;
  }

  /**
   * Changes how a list behaves. On a list in force, a change to who it applies to, its priority,
   * dates, tax basis or quantity rule moves live prices, so it may need approval; a new name or
   * description never does.
   */
  async updateListGated(
    companyId: string,
    id: string,
    patch: Partial<Omit<ListInput, 'code' | 'currency' | 'kind'>>,
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<Gated<{ version: number }>> {
    const direct = async () => ({
      pending: false as const,
      version: (await this.updateList(companyId, id, patch, actor, reason)).version,
    });
    const { why, current, changed } = await this.planListUpdate(companyId, id, patch, reason);
    const affectsPrices = changed.filter(([k]) => k !== 'name' && k !== 'description');
    if (current.status !== 'active' || affectsPrices.length === 0) return direct();
    const fields = affectsPrices.map(([k]) => k);
    const outcome = await this.gate.gate(
      {
        trigger: 'price_list.live_change',
        companyId,
        requestedBy: actor.id,
        amount: 0,
        facts: {
          changedLines: 0,
          largestRisePercent: 0,
          largestCutPercent: 0,
          newProducts: 0,
          removesPrices: false,
          headerChange: true,
          changedFields: fields.join(','),
          listKind: current.kind,
          listCode: current.code,
        },
        action: 'update_list',
        payload: {
          listId: id,
          patch: {
            ...patch,
            validFrom: patch.validFrom?.toISOString(),
            validTo:
              patch.validTo === undefined ? undefined : (patch.validTo?.toISOString() ?? null),
          },
          reason: why,
        },
        summary: `Change how live price list ${current.code} (${current.name}) applies: ${fields.join(', ')}. Reason: ${why.code.replace(/_/g, ' ').toLowerCase()}${why.text ? ` — ${why.text}` : ''}.`,
      },
      direct,
    );
    return outcome.parked ? { pending: true, message: outcome.message } : outcome.value;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Lists that would tie with this one: a sale could match both, in one currency, at equal
   * specificity and priority, and they price at least one product in common.
   */
  async findTies(
    companyId: string,
    candidate: Pick<
      ListRow,
      'id' | 'scopes' | 'validFrom' | 'validTo' | 'currency' | 'kind' | 'priority'
    >,
  ): Promise<RuleIssue[]> {
    const [weights, others] = await Promise.all([
      this.pricing.weights(companyId),
      this.db
        .select()
        .from(priceLists)
        .where(
          and(
            eq(priceLists.companyId, companyId),
            eq(priceLists.status, 'active'),
            ne(priceLists.id, candidate.id),
          ),
        ),
    ]);
    const issues: RuleIssue[] = [];
    for (const other of others) {
      if (!wouldTie(candidate, other, weights)) continue;
      const shared = await this.sharedProducts(candidate.id, other.id);
      if (shared.length > 0) {
        issues.push({
          path: other.code,
          message: `${other.code} would tie with this list for ${shared.length === 5 ? 'at least 5' : shared.length} product${shared.length === 1 ? '' : 's'} (for example ${shared[0]}): same customers, same priority and overlapping dates. Change the priority, the scope or the dates.`,
        });
      }
    }
    return issues;
  }

  private async sharedProducts(a: string, b: string): Promise<string[]> {
    const rows = await this.db.execute<{ product_id: string }>(sql`
      select l.product_id from price_list_lines l
      where l.price_list_id = ${a} and l.valid_to is null
        and exists (select 1 from price_list_lines o
                    where o.price_list_id = ${b} and o.product_id = l.product_id and o.valid_to is null)
      limit 5`);
    return [...rows].map((r) => r.product_id);
  }

  /** Why a list cannot go live, or an empty list when it can. */
  async activationIssues(companyId: string, id: string): Promise<RuleIssue[]> {
    const list = await this.getList(companyId, id);
    const issues: RuleIssue[] = [];
    if (list.status === 'retired') {
      issues.push({ path: 'status', message: 'A retired price list cannot be activated again.' });
      return issues;
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(priceListLines)
      .where(and(eq(priceListLines.priceListId, id), isNull(priceListLines.validTo)));
    if (Number(n) === 0) issues.push({ path: 'lines', message: 'Add at least one price first.' });
    if (list.validTo && list.validTo <= new Date())
      issues.push({ path: 'validTo', message: 'The list has already ended.' });
    issues.push(...validateScopes(list.scopes));
    issues.push(...(await this.checkScopeReferences(companyId, list.scopes)));
    issues.push(...(await this.findTies(companyId, list)));
    return issues;
  }

  /**
   * Asks for a draft list to be put in force. If an approval workflow applies to it, the list is
   * held (nothing prices from it) until the approvers release it; otherwise it goes live now,
   * exactly as `activate` does. The requester's reason is kept in the decision log and reused when
   * the approval releases the list.
   */
  async requestActivation(
    companyId: string,
    id: string,
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<
    | { outcome: 'active'; version: number }
    | { outcome: 'pending'; version: number; message: string }
  > {
    const why = await this.why(companyId, reason);
    const list = await this.getList(companyId, id);
    if (list.approvalStatus === 'pending')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'This price list is already waiting for approval.',
      );
    if (list.status !== 'draft')
      throw new PricingConfigError('NOT_EDITABLE', 'Only a draft price list can be put in force.');
    const issues = await this.activationIssues(companyId, id);
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);

    const request = await this.approvalRequest(companyId, id, actor.id);
    if (!(await this.approvals.wouldRequire(request))) {
      const row = await this.activate(companyId, id, actor, why);
      return { outcome: 'active', version: row.version };
    }

    const held = await withAfterCommit(this.db, async (tx) => {
      // Held first, in the same transaction as the request, so no sale can use a list that is
      // waiting. Nothing else may have started a request since the check above.
      const claimed = await tx
        .update(priceLists)
        .set({ approvalStatus: 'pending', updatedAt: new Date() })
        .where(and(eq(priceLists.id, id), ne(priceLists.approvalStatus, 'pending')))
        .returning({ id: priceLists.id });
      if (claimed.length === 0)
        throw new PricingConfigError(
          'CONFLICT',
          'This price list is already waiting for approval.',
        );
      // An earlier refusal no longer matters: the author has changed the list and asks again.
      await this.approvals.supersedePending(
        companyId,
        'price_list',
        id,
        { userId: actor.id },
        'Asked again.',
        tx,
        true,
      );
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_list', id },
          action: 'pricing.activation_requested',
          reason: why,
          from: 'draft',
          to: 'pending_approval',
          inputs: { changedLines: request.snapshot.changedLines },
        },
        tx,
      );
      const outcome = await this.approvals.submit(request, tx);
      if (!outcome.required) {
        // The rules changed a moment ago: nothing needs approval after all.
        await tx.update(priceLists).set({ approvalStatus: 'none' }).where(eq(priceLists.id, id));
        return false;
      }
      return true;
    });
    if (!held) {
      const row = await this.activate(companyId, id, actor, why);
      return { outcome: 'active', version: row.version };
    }
    // The approval may have been released straight away (every step skipped).
    const after = await this.getList(companyId, id);
    this.pricing.invalidate(companyId);
    if (after.status === 'active') return { outcome: 'active', version: after.version };
    return {
      outcome: 'pending',
      version: after.version,
      message:
        'Sent for approval. The list goes live as soon as it is approved; follow it under My requests.',
    };
  }

  private async approvalRequest(companyId: string, id: string, requestedBy: string) {
    return {
      companyId,
      trigger: 'price_list.publish',
      documentId: id,
      branchId: null,
      requestedBy,
      amount: 0,
      snapshot: { changedLines: await this.openLineCount(id) },
    };
  }

  private openLineCount(id: string): Promise<number> {
    return this.openLineCountIn(this.db, id);
  }

  /**
   * Puts the list in force. Called directly, or by the approval workflow once it releases (with the
   * approver's transaction as `writer`, so the list goes live in the same commit as the approval).
   */
  async activate(
    companyId: string,
    id: string,
    actor: Actor,
    reason: Why,
    writer?: Pick<DrizzleDb, 'update' | 'insert'>,
  ) {
    const why = await this.why(companyId, reason);
    const issues = await this.activationIssues(companyId, id);
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);
    const run = async (tx: Pick<DrizzleDb, 'update' | 'insert'>) => {
      const [row] = await tx
        .update(priceLists)
        .set({ status: 'active', approvalStatus: 'none', updatedAt: new Date() })
        .where(eq(priceLists.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_list', id },
          action: 'pricing.list_activated',
          reason: why,
          from: 'draft',
          to: 'active',
          outcome: { version: row!.version },
        },
        tx,
      );
      return row!;
    };
    if (writer) {
      const row = await run(writer);
      // Only once the approval's transaction has committed does the list really exist as active.
      afterCommit(writer, () => this.pricing.invalidate(companyId));
      return row;
    }
    const row = await this.db.transaction(run);
    this.pricing.invalidate(companyId);
    return row;
  }

  /** What an approval does to a list: held, released, refused, reopened or withdrawn. */
  async setApprovalState(tx: Pick<DrizzleDb, 'update'>, id: string, state: 'none' | 'rejected') {
    await tx
      .update(priceLists)
      .set({ approvalStatus: state, updatedAt: new Date() })
      .where(eq(priceLists.id, id));
  }

  /** Names for the customers, groups and branches that lists are limited to. */
  async scopeNames(lists: Array<{ scopes: Scopes }>) {
    const collect = (d: keyof Scopes) => [
      ...new Set(lists.flatMap((l) => l.scopes[d]?.values ?? [])),
    ];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ok = (ids: string[]) => ids.filter((i) => UUID.test(i));
    const [c, g, b] = [
      ok(collect('customer')),
      ok(collect('customer_group')),
      ok(collect('branch')),
    ];
    const [cs, gs, bs] = await Promise.all([
      c.length
        ? this.db
            .select({ id: customers.id, name: customers.name })
            .from(customers)
            .where(inArray(customers.id, c))
        : [],
      g.length
        ? this.db
            .select({ id: customerGroups.id, name: customerGroups.name })
            .from(customerGroups)
            .where(inArray(customerGroups.id, g))
        : [],
      b.length
        ? this.db
            .select({ id: branches.id, name: branches.name })
            .from(branches)
            .where(inArray(branches.id, b))
        : [],
    ]);
    const map = (rows: { id: string; name: string }[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r.name]));
    return { customer: map(cs), customer_group: map(gs), branch: map(bs) };
  }

  async openLineCountIn(db: Pick<DrizzleDb, 'select'>, id: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(priceListLines)
      .where(and(eq(priceListLines.priceListId, id), isNull(priceListLines.validTo)));
    return Number(row?.n ?? 0);
  }

  /** The reason the requester gave, kept when they asked, to be recorded when the approval releases. */
  async requestedWith(tx: Pick<DrizzleDb, 'select'>, id: string) {
    const [row] = await tx
      .select({
        code: decisionLog.reasonCode,
        text: decisionLog.reasonText,
        actorId: decisionLog.actorId,
      })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.subjectType, 'price_list'),
          eq(decisionLog.subjectId, id),
          eq(decisionLog.action, 'pricing.activation_requested'),
        ),
      )
      .orderBy(desc(decisionLog.occurredAt))
      .limit(1);
    return row ?? null;
  }

  async retire(companyId: string, id: string, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    const list = await this.getList(companyId, id);
    if (list.status === 'retired') return list;
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(priceLists)
        .set({ status: 'retired', approvalStatus: 'none', updatedAt: new Date() })
        .where(eq(priceLists.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_list', id },
          action: 'pricing.list_retired',
          reason: why,
          from: list.status,
          to: 'retired',
        },
        tx,
      );
      return updated!;
    });
    this.pricing.invalidate(companyId);
    return row;
  }

  // ── Lines ────────────────────────────────────────────────────────────────

  async listLines(
    companyId: string,
    id: string,
    opts: { search?: string; page?: number; pageSize?: number } = {},
  ) {
    await this.getList(companyId, id);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const search = opts.search?.trim();
    const where = and(
      eq(priceListLines.priceListId, id),
      isNull(priceListLines.validTo),
      search
        ? or(ilike(products.name, `%${search}%`), ilike(products.sku, `%${search}%`))
        : undefined,
    );
    const [rows, [{ n } = { n: 0 }]] = await Promise.all([
      this.db
        .select({
          line: priceListLines,
          name: products.name,
          sku: products.sku,
          standardPrice: products.price,
        })
        .from(priceListLines)
        .innerJoin(products, eq(products.id, priceListLines.productId))
        .where(where)
        .orderBy(asc(products.name))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ n: count() })
        .from(priceListLines)
        .innerJoin(products, eq(products.id, priceListLines.productId))
        .where(where),
    ]);
    return { rows, total: Number(n), page, pageSize };
  }

  /** Every price a product has had in a list, newest first. */
  async lineHistory(companyId: string, id: string, productId: string) {
    await this.getList(companyId, id);
    return this.db
      .select()
      .from(priceListLines)
      .where(and(eq(priceListLines.priceListId, id), eq(priceListLines.productId, productId)))
      .orderBy(desc(priceListLines.validFrom), desc(priceListLines.createdAt));
  }

  /**
   * Sets prices. Each product's open price is closed at the start of the new one and a new row is
   * added, so history is kept. A price starts now (or later), never in the past. A product whose
   * price is already exactly as given is left alone, so sending a file twice changes nothing.
   */
  /** Everything that can be refused about a batch of prices, before anything is held or written. */
  private async checkLines(
    companyId: string,
    id: string,
    rows: LineInput[],
    reason: Why,
    opts: { validFrom?: Date },
  ) {
    const why = await this.why(companyId, reason);
    const list = await this.getList(companyId, id);
    if (list.status === 'retired')
      throw new PricingConfigError('NOT_EDITABLE', 'A retired price list cannot be changed.');
    if (list.approvalStatus === 'pending')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'This price list is waiting for approval. Cancel the request before changing it.',
      );
    if (rows.length === 0) throw new PricingConfigError('INVALID', 'There are no prices to set.');
    if (rows.length > MAX_LINES_PER_CALL)
      throw new PricingConfigError(
        'TOO_MANY',
        `Send at most ${MAX_LINES_PER_CALL.toLocaleString()} prices at a time.`,
      );
    const now = new Date();
    const from = opts.validFrom ?? now;
    if (from.getTime() < now.getTime() - CLOCK_GRACE_MS)
      throw new PricingConfigError(
        'INVALID',
        'A price cannot start in the past. Past prices stay as they were.',
      );
    const start = from.getTime() < now.getTime() ? now : from;

    // Last row for a product wins inside one batch.
    const byProduct = new Map<string, LineInput>();
    for (const r of rows) byProduct.set(r.productId, r);
    const issues: RuleIssue[] = [];
    for (const [pid, r] of byProduct) {
      const tiers = [...(r.tiers ?? [])].sort((a, b) => a.fromQty - b.fromQty);
      for (const i of validateTiers(tiers, r.price))
        issues.push({ path: `${pid}.${i.path}`, message: i.message });
      if (r.floorPrice != null && !(r.floorPrice >= 0))
        issues.push({
          path: `${pid}.floorPrice`,
          message: 'The floor price must be zero or more.',
        });
    }
    const ids = [...byProduct.keys()];
    const existing = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(inArray(products.id, ids), isNull(products.deletedAt)));
    const known = new Set(existing.map((p) => p.id));
    const unknown = ids.filter((p) => !known.has(p));
    if (unknown.length)
      issues.push({
        path: 'products',
        message: `${unknown.length} product${unknown.length === 1 ? '' : 's'} do not exist (for example ${unknown[0]}).`,
      });
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);

    if (list.status === 'active') {
      // A product added to a live list must not tie with another live list on the same sale.
      const ties = await this.tiesForProducts(companyId, list, ids);
      if (ties.length) throw new PricingConfigError('CONFLICT', ties[0]!.message, ties);
    }
    return { why, list, now, start, byProduct, ids };
  }

  async setLines(
    companyId: string,
    id: string,
    rows: LineInput[],
    actor: Actor,
    reason: Why,
    opts: { validFrom?: Date; overrideLock?: boolean; writer?: Tx } = {},
  ) {
    const { why, list, now, start, byProduct, ids } = await this.checkLines(
      companyId,
      id,
      rows,
      reason,
      opts,
    );

    const result = await this.inTx(opts.writer, companyId, async (tx) => {
      const open = await tx
        .select()
        .from(priceListLines)
        .where(
          and(
            eq(priceListLines.priceListId, id),
            inArray(priceListLines.productId, ids),
            or(isNull(priceListLines.validTo), gt(priceListLines.validTo, start)),
          ),
        );
      const current = new Map<string, LineRow[]>();
      for (const r of open) current.set(r.productId, [...(current.get(r.productId) ?? []), r]);

      let created = 0;
      let replaced = 0;
      let unchanged = 0;
      const changes: Array<{ productId: string; from: number | null; to: number }> = [];
      const toInsert: (typeof priceListLines.$inferInsert)[] = [];
      const toClose: Array<{ id: string; at: Date }> = [];

      for (const [pid, input] of byProduct) {
        const tiers = [...(input.tiers ?? [])].sort((a, b) => a.fromQty - b.fromQty);
        const rowsFor = current.get(pid) ?? [];
        const inForce = rowsFor.find(
          (r) => r.validFrom <= start && (r.validTo === null || r.validTo > start),
        );
        const scheduled = rowsFor.filter((r) => r.validFrom > start);
        if (inForce && scheduled.length === 0 && isSamePrice(inForce, input, tiers)) {
          unchanged++;
          continue;
        }
        if (inForce?.lockedUntil && inForce.lockedUntil > now && !opts.overrideLock) {
          throw new PricingConfigError(
            'LOCKED',
            `The price of ${pid} is locked until ${inForce.lockedUntil.toISOString().slice(0, 10)}.`,
          );
        }
        if (inForce) toClose.push({ id: inForce.id, at: start });
        // A change made now replaces anything already scheduled after it.
        for (const s of scheduled) toClose.push({ id: s.id, at: s.validFrom });
        if (inForce) replaced++;
        else created++;
        changes.push({
          productId: pid,
          from: inForce ? Number(inForce.price) : null,
          to: input.price,
        });
        toInsert.push({
          priceListId: id,
          productId: pid,
          price: input.price.toFixed(4),
          tiers,
          floorPrice: input.floorPrice == null ? null : input.floorPrice.toFixed(4),
          lockedUntil: input.lockedUntil ?? null,
          validFrom: start,
          reasonCode: why.code,
          createdBy: actor.id ?? 'system',
        });
      }

      for (const c of toClose) {
        await tx.update(priceListLines).set({ validTo: c.at }).where(eq(priceListLines.id, c.id));
      }
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
        await tx.insert(priceListLines).values(toInsert.slice(i, i + INSERT_CHUNK));
      }
      if (changes.length > 0) {
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'price_list', id },
            action: 'pricing.prices_changed',
            reason: why,
            inputs: { startsAt: start.toISOString(), listVersion: list.version },
            outcome: { created, replaced, unchanged, sample: changes.slice(0, 20) },
          },
          tx,
        );
      }
      return { created, replaced, unchanged };
    });
    return result;
  }

  /** Stops pricing the given products from now on. Their history stays. */
  async removeLines(
    companyId: string,
    id: string,
    productIds: string[],
    actor: Actor,
    reason: Why,
    opts: { overrideLock?: boolean; writer?: Tx } = {},
  ) {
    const why = await this.why(companyId, reason);
    const list = await this.getList(companyId, id);
    if (list.status === 'retired' || list.approvalStatus === 'pending')
      throw new PricingConfigError('NOT_EDITABLE', 'This price list cannot be changed right now.');
    if (productIds.length === 0 || productIds.length > MAX_LINES_PER_CALL)
      throw new PricingConfigError('INVALID', 'Choose the products to remove.');
    const now = new Date();
    const removed = await this.inTx(opts.writer, companyId, async (tx) => {
      const open = await tx
        .select()
        .from(priceListLines)
        .where(
          and(
            eq(priceListLines.priceListId, id),
            inArray(priceListLines.productId, productIds),
            isNull(priceListLines.validTo),
          ),
        );
      const locked = open.find((r) => r.lockedUntil && r.lockedUntil > now);
      if (locked && !opts.overrideLock)
        throw new PricingConfigError('LOCKED', `The price of ${locked.productId} is locked.`);
      for (const r of open) {
        await tx
          .update(priceListLines)
          // A scheduled row is voided at its own start, so it never applies.
          .set({ validTo: r.validFrom > now ? r.validFrom : now })
          .where(eq(priceListLines.id, r.id));
      }
      if (open.length > 0) {
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'price_list', id },
            action: 'pricing.prices_removed',
            reason: why,
            outcome: { removed: open.length, sample: open.slice(0, 20).map((r) => r.productId) },
          },
          tx,
        );
      }
      return open.length;
    });
    return { removed };
  }

  private async tiesForProducts(
    companyId: string,
    list: ListRow,
    productIds: string[],
  ): Promise<RuleIssue[]> {
    const weights = await this.pricing.weights(companyId);
    const others = await this.db
      .select()
      .from(priceLists)
      .where(
        and(
          eq(priceLists.companyId, companyId),
          eq(priceLists.status, 'active'),
          ne(priceLists.id, list.id),
        ),
      );
    const tied = others.filter((o) => wouldTie(list, o, weights));
    if (tied.length === 0) return [];
    const issues: RuleIssue[] = [];
    for (const o of tied) {
      const hit = await this.db
        .select({ productId: priceListLines.productId })
        .from(priceListLines)
        .where(
          and(
            eq(priceListLines.priceListId, o.id),
            isNull(priceListLines.validTo),
            inArray(priceListLines.productId, productIds),
          ),
        )
        .limit(1);
      if (hit[0])
        issues.push({
          path: o.code,
          message: `${o.code} already prices ${hit[0].productId} at the same rank (same customers, priority and dates). Change the priority or scope first.`,
        });
    }
    return issues;
  }

  async timeline(id: string) {
    return this.decisions.timeline('price_list', id);
  }

  // ── Customer groups ──────────────────────────────────────────────────────

  async listGroups(companyId: string) {
    const rows = await this.db
      .select()
      .from(customerGroups)
      .where(eq(customerGroups.companyId, companyId))
      .orderBy(desc(customerGroups.priority), asc(customerGroups.code));
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ id: customerGroupMembers.groupId, n: count() })
      .from(customerGroupMembers)
      .where(
        inArray(
          customerGroupMembers.groupId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(customerGroupMembers.groupId);
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((r) => ({ ...r, memberCount: byId.get(r.id) ?? 0 }));
  }

  async saveGroup(
    companyId: string,
    input: {
      id?: string;
      code: string;
      name: string;
      description?: string | null;
      priority?: number;
      isActive?: boolean;
    },
    actor: Actor,
    reason: Why,
  ): Promise<GroupRow> {
    const why = await this.why(companyId, reason);
    const code = this.normaliseCode(input.code);
    if (!input.name?.trim()) throw new PricingConfigError('INVALID', 'Give the group a name.');
    const [dup] = await this.db
      .select({ id: customerGroups.id })
      .from(customerGroups)
      .where(
        and(
          eq(customerGroups.companyId, companyId),
          eq(customerGroups.code, code),
          input.id ? ne(customerGroups.id, input.id) : undefined,
        ),
      )
      .limit(1);
    if (dup) throw new PricingConfigError('DUPLICATE_CODE', `A group ${code} already exists.`);
    const values = {
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      priority: input.priority ?? 0,
      isActive: input.isActive ?? true,
    };
    const row = await this.db.transaction(async (tx) => {
      let saved: GroupRow;
      if (input.id) {
        const [before] = await tx
          .select()
          .from(customerGroups)
          .where(and(eq(customerGroups.companyId, companyId), eq(customerGroups.id, input.id)))
          .limit(1);
        if (!before) throw new PricingConfigError('NOT_FOUND', 'That group does not exist.');
        [saved] = await tx
          .update(customerGroups)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(customerGroups.id, input.id))
          .returning();
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'customer_group', id: input.id },
            action: 'pricing.group_changed',
            reason: why,
            inputs: { priority: before.priority, isActive: before.isActive, name: before.name },
            outcome: values,
          },
          tx,
        );
      } else {
        [saved] = await tx
          .insert(customerGroups)
          .values({ companyId, ...values })
          .returning();
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'customer_group', id: saved!.id },
            action: 'pricing.group_created',
            reason: why,
            outcome: values,
          },
          tx,
        );
      }
      return saved!;
    });
    return row;
  }

  async groupMembers(companyId: string, groupId: string, search?: string) {
    const [g] = await this.db
      .select({ id: customerGroups.id })
      .from(customerGroups)
      .where(and(eq(customerGroups.companyId, companyId), eq(customerGroups.id, groupId)))
      .limit(1);
    if (!g) throw new PricingConfigError('NOT_FOUND', 'That group does not exist.');
    const s = search?.trim();
    return this.db
      .select({
        id: customers.id,
        number: customers.number,
        name: customers.name,
        email: customers.email,
      })
      .from(customerGroupMembers)
      .innerJoin(customers, eq(customers.id, customerGroupMembers.customerId))
      .where(
        and(
          eq(customerGroupMembers.groupId, groupId),
          s ? or(ilike(customers.name, `%${s}%`), ilike(customers.number, `%${s}%`)) : undefined,
        ),
      )
      .orderBy(asc(customers.name))
      .limit(200);
  }

  async changeMembers(
    companyId: string,
    groupId: string,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    const [g] = await this.db
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.companyId, companyId), eq(customerGroups.id, groupId)))
      .limit(1);
    if (!g) throw new PricingConfigError('NOT_FOUND', 'That group does not exist.');
    const add = [...new Set(change.add ?? [])];
    const remove = [...new Set(change.remove ?? [])];
    if (add.length + remove.length === 0)
      throw new PricingConfigError('INVALID', 'Choose customers to add or remove.');
    if (add.length + remove.length > MAX_LINES_PER_CALL)
      throw new PricingConfigError('TOO_MANY', 'Too many customers at once.');
    const result = await this.db.transaction(async (tx) => {
      let added = 0;
      if (add.length) {
        const valid = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.companyId, companyId), inArray(customers.id, add)));
        if (valid.length !== add.length)
          throw new PricingConfigError('INVALID', 'Some of those customers do not exist.');
        const ins = await tx
          .insert(customerGroupMembers)
          .values(add.map((customerId) => ({ groupId, customerId, addedBy: actor.id ?? 'system' })))
          .onConflictDoNothing()
          .returning({ id: customerGroupMembers.customerId });
        added = ins.length;
      }
      let removed = 0;
      if (remove.length) {
        const del = await tx
          .delete(customerGroupMembers)
          .where(
            and(
              eq(customerGroupMembers.groupId, groupId),
              inArray(customerGroupMembers.customerId, remove),
            ),
          )
          .returning({ id: customerGroupMembers.customerId });
        removed = del.length;
      }
      if (added + removed > 0) {
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'customer_group', id: groupId },
            action: 'pricing.group_members_changed',
            reason: why,
            outcome: {
              added,
              removed,
              sampleAdded: add.slice(0, 20),
              sampleRemoved: remove.slice(0, 20),
            },
          },
          tx,
        );
      }
      return { added, removed };
    });
    return result;
  }

  /** Customers matching a search, for pickers. */
  async searchCustomers(companyId: string, search: string, limit = 20) {
    const s = search.trim();
    if (s.length < 2) return [];
    return this.db
      .select({ id: customers.id, number: customers.number, name: customers.name })
      .from(customers)
      .where(
        and(
          eq(customers.companyId, companyId),
          or(
            ilike(customers.name, `%${s}%`),
            ilike(customers.number, `%${s}%`),
            ilike(customers.email, `%${s}%`),
          ),
        ),
      )
      .orderBy(asc(customers.name))
      .limit(limit);
  }

  async searchProducts(search: string, limit = 20) {
    const s = search.trim();
    if (s.length < 2) return [];
    return this.db
      .select({ id: products.id, name: products.name, sku: products.sku, price: products.price })
      .from(products)
      .where(
        and(
          isNull(products.deletedAt),
          or(ilike(products.name, `%${s}%`), ilike(products.sku, `%${s}%`)),
        ),
      )
      .orderBy(asc(products.name))
      .limit(limit);
  }

  // ── Specificity weights ──────────────────────────────────────────────────

  async getWeights(companyId: string): Promise<SpecificityWeights> {
    return this.pricing.weights(companyId);
  }

  async setWeights(
    companyId: string,
    patch: Partial<SpecificityWeights>,
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    const keys = Object.keys(patch) as Array<keyof SpecificityWeights>;
    for (const k of keys) {
      if (!(k in DEFAULT_WEIGHTS))
        throw new PricingConfigError('INVALID', `"${k}" is not a weight that can be set.`);
      const v = patch[k]!;
      if (!Number.isInteger(v) || v < 0 || v > 100000)
        throw new PricingConfigError('INVALID', 'Weights are whole numbers from 0 to 100,000.');
    }
    const before = { ...(await this.pricing.weights(companyId)) };
    await this.db.transaction(async (tx) => {
      for (const k of keys) {
        await tx
          .insert(priceSpecificityWeights)
          .values({ companyId, dimension: k, weight: patch[k]! })
          .onConflictDoUpdate({
            target: [priceSpecificityWeights.companyId, priceSpecificityWeights.dimension],
            set: { weight: patch[k]!, updatedAt: new Date() },
          });
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_weights', id: companyId },
          action: 'pricing.weights_changed',
          reason: why,
          inputs: Object.fromEntries(keys.map((k) => [k, before[k]])),
          outcome: Object.fromEntries(keys.map((k) => [k, patch[k]])),
        },
        tx,
      );
    });
    this.pricing.invalidate(companyId);
    return this.pricing.weights(companyId);
  }

  async resetWeights(companyId: string, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    const before = await this.pricing.weights(companyId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(priceSpecificityWeights)
        .where(eq(priceSpecificityWeights.companyId, companyId));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_weights', id: companyId },
          action: 'pricing.weights_reset',
          reason: why,
          inputs: { ...before },
          outcome: { ...DEFAULT_WEIGHTS },
        },
        tx,
      );
    });
    this.pricing.invalidate(companyId);
  }
}
