import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches } from '@/server/db/drizzle/schema';
import { chooseBranch, choiceWords, type BranchOption } from '@/lib/branch-choice';
import { hasAnyKey, keysOf, type AddressWords } from '@/lib/delivery-zones';
import type { DeliveryMethod } from '@/lib/delivery-methods';
import { isGeoPoint, type GeoPoint } from '@/lib/geo';
import type { ChoiceRecord, DestinationRecord } from '@/lib/order-delivery';
import type { SalesChannel } from '@/lib/stock';
import { roundQty } from '@/lib/decimal';
import type { GeoService } from '@/server/domains/geo/service';
import type { StockAvailability } from '@/server/domains/stock/availability';
import type { StockSettingsService } from '@/server/domains/stock/settings';
import type { DeliveryMethods } from './methods';
import type { DeliveryQuotes, QuoteRefusal, QuoteResult } from './quote';
import { placeAddress } from './geocode';

export interface PlanInput {
  at: Date;
  currency: string;
  channel: SalesChannel;
  method: DeliveryMethod;
  /** For collection: the branch the customer chose. It is checked here, never trusted. */
  pickupBranchId?: string | null;
  /** What is to be delivered, as the stock lines of the order (kits already broken into their parts). */
  lines: readonly { productId: string; quantity: number }[];
  customerId?: string | null;
  customerGroupId?: string | null;
  salesType?: string | null;
  country?: string | null;
  address?: AddressWords;
  pin?: GeoPoint | null;
  weightKg: number;
  /** What the customer pays for the goods, for the policy's order-value discounts. */
  orderValue: number;
}

export type PlanRefusal = QuoteRefusal | 'no_destination' | 'no_branch' | 'method_not_available';
type Quoted = Extract<QuoteResult, { ok: true }>;

export type PlanResult =
  | { ok: true; branch: { id: string; code: string; name: string }; choice: ChoiceRecord; destination: DestinationRecord; quote: Quoted; /** Set when the order is to be collected: the branch, as the customer was shown it. */ pickup?: PickupPoint }
  | { ok: false; reason: PlanRefusal; message: string; choice: ChoiceRecord | null; destination: DestinationRecord };

/** A branch the customer can collect from, with what the shop says about it. */
export interface PickupPoint {
  branchId: string;
  code: string;
  name: string;
  address: string;
  /** The parts of the address, for writing it on an order. */
  street: string | null;
  city: string | null;
  county: string | null;
  phone: string | null;
  /** What the person who pinned the branch called the place (a shop front, a gate). */
  landmark: string | null;
  /** How long the branch needs to get an order ready. */
  leadTimeMinutes: number;
  note: string | null;
  /** Whether it has every line of the order. */
  holdsAll: boolean;
  totalLines: number;
}

const EXCLUDED_WORDS = { method_not_offered: 'does not offer this way of delivering', no_pin: 'has no map pin', holds_none_of_it: 'has none of the goods' } as const;

/**
 * Delivery for an order, decided on the server from the customer's pin or address: the nearest branch that can cover the order
 * (and offers the method), then the charge from that branch under the policy that applies. The browser supplies only the customer's
 * side and the basket; the branch, the policy and the money are never taken from it. The same facts give the same answer.
 */
export class DeliveryPlans {
  constructor(
    private readonly db: DrizzleDb,
    private readonly geo: GeoService,
    private readonly methods: DeliveryMethods,
    private readonly availability: StockAvailability,
    private readonly stockSettings: Pick<StockSettingsService, 'isLedgerMode'>,
    private readonly quotes: DeliveryQuotes,
  ) {}

  /**
   * The branches this order can be collected from: those that offer collection and hold all of it (without the per-location ledger
   * there is no stock by branch, so every branch that offers collection counts). The customer picks one; the server checks the pick.
   */
  async pickupPoints(companyId: string, input: { lines: readonly { productId: string; quantity: number }[]; channel: SalesChannel }): Promise<PickupPoint[]> {
    const rows = await this.db
      .select({ id: branches.id, code: branches.code, name: branches.name, street: branches.streetAddress, city: branches.city, county: branches.countyOrState, phone: branches.phone, pinLabel: branches.pinLabel })
      .from(branches)
      .where(and(eq(branches.companyId, companyId), eq(branches.isActive, true)));
    const ids = rows.map((r) => r.id);
    const [offered, grids, ledger] = await Promise.all([
      this.methods.forBranches(companyId, ids),
      this.availability.byBranch(companyId, ids, input.lines.map((l) => l.productId), input.channel),
      this.stockSettings.isLedgerMode(),
    ]);
    const wanted = mergeByProduct(input.lines);
    return rows.flatMap((r) => {
      const offer = (offered.get(r.id) ?? []).find((m) => m.method === 'pickup' && m.isActive);
      if (offer === undefined) return [];
      const grid = grids.get(r.id);
      const holdsAll = !ledger || wanted.every((l) => (grid?.get(l.productId) ?? 0) >= l.quantity);
      const address = [r.street, r.city, r.county].filter((part): part is string => part !== null && part.trim() !== '').join(', ');
      return [{ branchId: r.id, code: r.code, name: r.name, address, street: r.street, city: r.city, county: r.county, phone: r.phone, landmark: r.pinLabel, leadTimeMinutes: offer.leadTimeMinutes, note: offer.note, holdsAll, totalLines: wanted.length }];
    });
  }

  /** Collection from a branch the customer chose: no charge, and the branch must really offer collection and hold the whole order. */
  private async planPickup(companyId: string, input: PlanInput, destination: DestinationRecord): Promise<PlanResult> {
    const refuse = (reason: PlanRefusal, message: string): PlanResult => ({ ok: false, reason, message, choice: null, destination });
    const wanted = input.pickupBranchId;
    if (wanted === undefined || wanted === null || wanted === '') return refuse('no_branch', 'Choose the branch you will collect from.');
    const points = await this.pickupPoints(companyId, { lines: input.lines, channel: input.channel });
    const point = points.find((p) => p.branchId === wanted);
    if (point === undefined) return refuse('method_not_available', 'That branch does not offer collection. Choose another branch.');
    if (!point.holdsAll) return refuse('no_branch', `${point.name} does not have everything in this order right now. Choose another branch.`);
    const chosen = { branchId: point.branchId, code: point.code, name: point.name, km: null, minutes: null, coversLines: point.totalLines, totalLines: point.totalLines };
    const choice: ChoiceRecord = {
      reason: 'customer_chose',
      words: choiceWords({ chosen: { ...chosen, coversUnits: 0, totalUnits: 0, offersMethod: true }, reason: 'customer_chose', ranked: [], excluded: [], passedOver: [], partial: false }),
      chosen,
      ranked: [{ branchId: point.branchId, code: point.code, km: null, coversLines: point.totalLines, totalLines: point.totalLines }],
      excluded: [],
      passedOver: [],
      partial: false,
      provider: 'none',
      degraded: false,
    };
    const quote: Quoted = { ok: true, amount: 0, split: { net: 0, tax: 0, gross: 0 }, taxRate: 0, currency: input.currency, steps: [{ kind: 'base', label: 'Collecting from the branch: no charge', amount: 0, running: 0 }], policy: null, zone: null, route: null, considered: [] };
    return { ok: true, branch: { id: point.branchId, code: point.code, name: point.name }, choice, destination, quote, pickup: point };
  }

  async plan(companyId: string, input: PlanInput): Promise<PlanResult> {
    const pin = input.pin !== undefined && input.pin !== null && isGeoPoint(input.pin) ? input.pin : null;
    const address = input.address !== undefined && hasAnyKey(keysOf(input.address)) ? input.address : undefined;
    const empty: DestinationRecord = { pin, address: address ?? null, positionFrom: 'none', approximate: false };
    if (input.method === 'pickup') return await this.planPickup(companyId, input, empty);
    if (pin === null && address === undefined) return { ok: false, reason: 'no_destination', message: 'Give a map pin or an address, so we can tell which branch delivers this order and what the delivery costs.', choice: null, destination: empty };

    // Where the customer is: the pin if there is one, else the written address placed on the map (approximate).
    let point = pin;
    let approximate = false;
    if (point === null && address !== undefined) {
      point = await placeAddress(this.geo, address);
      approximate = point !== null;
    }
    const destination: DestinationRecord = { pin, address: address ?? null, positionFrom: positionOf(pin, point), approximate };

    const rows = await this.db.select({ id: branches.id, code: branches.code, name: branches.name, latitude: branches.latitude, longitude: branches.longitude }).from(branches).where(and(eq(branches.companyId, companyId), eq(branches.isActive, true)));
    const ids = rows.map((r) => r.id);
    const [offered, grids, ledger] = await Promise.all([
      this.methods.forBranches(companyId, ids),
      this.availability.byBranch(companyId, ids, input.lines.map((l) => l.productId), input.channel),
      this.stockSettings.isLedgerMode(),
    ]);

    const wanted = mergeByProduct(input.lines);
    const totalUnits = roundQty(wanted.reduce((n, l) => n + l.quantity, 0));
    const pins = rows.map((r) => ({ item: r, point: r.latitude !== null && r.longitude !== null ? { latitude: r.latitude, longitude: r.longitude } : null }));
    const near = point === null ? null : await this.geo.nearest(point, pins);
    const routeOf = new Map(near?.ranked.map((r) => [r.item.id, r.route]) ?? []);

    const options: BranchOption[] = rows.map((r) => {
      const grid = grids.get(r.id);
      // Without the per-location ledger there is no stock by branch to go by; every branch counts as able to supply it.
      const free = (productId: string): number => (ledger ? (grid?.get(productId) ?? 0) : Number.POSITIVE_INFINITY);
      const route = routeOf.get(r.id);
      return {
        branchId: r.id,
        code: r.code,
        name: r.name,
        km: route?.km ?? null,
        minutes: route?.minutes ?? null,
        coversLines: wanted.filter((l) => free(l.productId) >= l.quantity).length,
        totalLines: wanted.length,
        coversUnits: roundQty(wanted.reduce((n, l) => n + Math.min(free(l.productId), l.quantity), 0)),
        totalUnits,
        offersMethod: (offered.get(r.id) ?? []).some((m) => m.method === input.method && m.isActive),
      };
    });

    const result = chooseBranch(options, point !== null);
    const provider = near?.provider ?? 'builtin';
    const degraded = near?.degraded ?? false;
    if (result.chosen === null) {
      const nameOf = new Map(rows.map((r) => [r.id, r.name]));
      const why = result.excluded.map((e) => `${nameOf.get(e.branchId) ?? e.code} ${EXCLUDED_WORDS[e.why]}`).join('; ');
      return { ok: false, reason: 'no_branch', message: `No branch can deliver this order${why === '' ? '.' : `: ${why}.`}`, choice: null, destination };
    }
    const chosen = result.chosen;
    const choice: ChoiceRecord = {
      reason: result.reason,
      words: choiceWords(result),
      chosen: { branchId: chosen.branchId, code: chosen.code, name: chosen.name, km: chosen.km, minutes: chosen.minutes, coversLines: chosen.coversLines, totalLines: chosen.totalLines },
      ranked: result.ranked.map((o) => ({ branchId: o.branchId, code: o.code, km: o.km, coversLines: o.coversLines, totalLines: o.totalLines })),
      excluded: result.excluded,
      passedOver: result.passedOver,
      partial: result.partial,
      provider,
      degraded,
    };

    const quote = await this.quotes.quote(companyId, {
      branchId: chosen.branchId,
      at: input.at,
      currency: input.currency,
      channel: input.channel,
      customerId: input.customerId ?? null,
      customerGroupId: input.customerGroupId ?? null,
      salesType: input.salesType ?? null,
      country: input.country ?? null,
      ...(address === undefined ? {} : { address }),
      pin,
      placed: point === null ? null : { point, approximate },
      weightKg: input.weightKg,
      orderValue: input.orderValue,
    });
    if (!quote.ok) return { ok: false, reason: quote.reason, message: quote.message, choice, destination };
    return { ok: true, branch: { id: chosen.branchId, code: chosen.code, name: chosen.name }, choice, destination, quote };
  }
}

function positionOf(pin: GeoPoint | null, point: GeoPoint | null): DestinationRecord['positionFrom'] {
  if (pin !== null) return 'pin';
  return point === null ? 'none' : 'address';
}

function mergeByProduct(lines: readonly { productId: string; quantity: number }[]): { productId: string; quantity: number }[] {
  const total = new Map<string, number>();
  for (const l of lines) if (l.quantity > 0) total.set(l.productId, roundQty((total.get(l.productId) ?? 0) + l.quantity));
  return [...total].map(([productId, quantity]) => ({ productId, quantity }));
}
