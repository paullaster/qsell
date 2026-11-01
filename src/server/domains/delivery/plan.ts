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
  | { ok: true; branch: { id: string; code: string; name: string }; choice: ChoiceRecord; destination: DestinationRecord; quote: Quoted }
  | { ok: false; reason: PlanRefusal; message: string; choice: ChoiceRecord | null; destination: DestinationRecord };

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

  async plan(companyId: string, input: PlanInput): Promise<PlanResult> {
    const pin = input.pin !== undefined && input.pin !== null && isGeoPoint(input.pin) ? input.pin : null;
    const address = input.address !== undefined && hasAnyKey(keysOf(input.address)) ? input.address : undefined;
    const empty: DestinationRecord = { pin, address: address ?? null, positionFrom: 'none', approximate: false };
    if (input.method === 'pickup') return { ok: false, reason: 'method_not_available', message: 'Collection from a branch is not available yet.', choice: null, destination: empty };
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
