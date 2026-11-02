import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches } from '@/server/db/drizzle/schema';
import { isGeoPoint, type GeoPoint } from '@/lib/geo';
import type { AddressWords } from '@/lib/delivery-zones';
import { DEFAULT_BUSINESS_TIMEZONE } from '@/server/kernel/numbering/business-date';
import type { GeoService } from '@/server/domains/geo/service';
import { toHeader, type ChargePolicies } from './charge-policies';
import type { DeliveryZones } from './zones';
import { quoteCharge } from './domain/engine';
import { choosePolicy, type Considered } from './domain/select';
import { splitTax, type TaxSplit } from '@/lib/delivery-tax';
import { placeAddress } from './geocode';
import type { ChargeQuote, Leg, RefusalReason } from './domain/types';

export interface QuoteInput {
  branchId: string;
  at: Date;
  currency: string;
  channel?: string | null;
  customerId?: string | null;
  customerGroupId?: string | null;
  salesType?: string | null;
  country?: string | null;
  address?: AddressWords;
  pin?: GeoPoint | null;
  /** The point to measure to when the caller has already found it (a pin, or a written address placed on the map); saves placing it twice. */
  placed?: { point: GeoPoint; approximate: boolean } | null;
  weightKg: number;
  orderValue: number;
}

export type QuoteRefusal = RefusalReason | 'no_policy' | 'no_branch' | 'branch_has_no_pin';

export type QuoteResult =
  | {
      ok: true;
      amount: number;
      /** The amount split into the charge before tax, the tax on it, and what the customer pays. */
      split: TaxSplit;
      taxRate: number;
      currency: string;
      steps: Extract<ChargeQuote, { ok: true }>['steps'];
      /** The policy that worked the charge out. Null when no policy applies: collecting an order from a branch costs nothing. */
      policy: { id: string; code: string; name: string; version: number; method: string } | null;
      zone: { id: string; code: string; name: string; by: 'pin' | 'address' } | null;
      route: { km: number; minutes: number | null; provider: string; degraded: boolean; approximate: boolean } | null;
      considered: Considered[];
    }
  | { ok: false; reason: QuoteRefusal; message: string; considered: Considered[] };

/**
 * The delivery charge for an order from a branch to a customer: the branch's pin, the zone of the customer's address or pin, the
 * distance from a map service (with a built-in estimate to fall back on), the policy that applies, and the charge with its trace.
 * It decides everything about the branch and the policy itself; the browser supplies only the customer's side.
 */
export class DeliveryQuotes {
  constructor(
    private readonly db: DrizzleDb,
    private readonly policies: ChargePolicies,
    private readonly zones: DeliveryZones,
    private readonly geo: GeoService,
  ) {}

  async quote(companyId: string, input: QuoteInput): Promise<QuoteResult> {
    const [branch] = await this.db.select({ id: branches.id, code: branches.code, name: branches.name, latitude: branches.latitude, longitude: branches.longitude }).from(branches).where(and(eq(branches.id, input.branchId), eq(branches.companyId, companyId)));
    if (branch === undefined) return { ok: false, reason: 'no_branch', message: 'That branch does not exist.', considered: [] };

    const inForce = await this.policies.inForce(companyId);
    const { chosen, considered } = choosePolicy(inForce.map((p) => toHeader(p.row)), { at: input.at, currency: input.currency, branchId: input.branchId, channel: input.channel, customerId: input.customerId, customerGroupId: input.customerGroupId, salesType: input.salesType, country: input.country });
    const policy = chosen === null ? undefined : inForce.find((p) => p.row.id === chosen.id);
    if (policy === undefined) return { ok: false, reason: 'no_policy', message: `No delivery charge policy in force applies to ${input.currency} orders from ${branch.name} at this time.`, considered };

    const pin = input.pin !== undefined && input.pin !== null && isGeoPoint(input.pin) ? input.pin : null;
    const match = pin === null && input.address === undefined ? null : await this.zones.resolve(companyId, { ...(input.address === undefined ? {} : { address: input.address }), pin });
    let out: Leg | null = null;
    let back: Leg | null = null;
    let provider = 'builtin';
    let degraded = false;
    let approximate = false;

    if (policy.def.method === 'distance') {
      if (branch.latitude === null || branch.longitude === null) return { ok: false, reason: 'branch_has_no_pin', message: `${branch.name} has no map pin, so a distance cannot be measured from it. Set its pin on the branches screen.`, considered };
      const from: GeoPoint = { latitude: branch.latitude, longitude: branch.longitude };
      let to = input.placed?.point ?? pin;
      approximate = input.placed?.approximate ?? false;
      if (to === null && input.address !== undefined) {
        to = await placeAddress(this.geo, input.address);
        approximate = to !== null;
      }
      if (to !== null) {
        const first = await this.geo.distancesFrom(from, [to]);
        const leg = first.value.at(0);
        provider = first.provider;
        degraded = first.degraded;
        if (leg !== undefined) out = { km: leg.km, minutes: leg.minutes };
        if (out !== null && policy.def.distanceBasis !== 'one_way') {
          const returning = await this.geo.distancesFrom(to, [from]);
          degraded = degraded || returning.degraded;
          const backLeg = returning.value.at(0);
          if (backLeg !== undefined) back = { km: backLeg.km, minutes: backLeg.minutes };
        }
      }
    }

    const quote = quoteCharge(policy.def, { at: input.at, timeZone: DEFAULT_BUSINESS_TIMEZONE, zoneId: match?.zone.id ?? null, zoneName: match?.zone.name ?? null, out, back, distanceApproximate: approximate, orderValue: input.orderValue, weightKg: input.weightKg });
    if (!quote.ok) return { ok: false, reason: quote.reason, message: quote.message, considered };
    return {
      ok: true,
      amount: quote.amount,
      split: splitTax(quote.amount, Number(policy.row.taxRate), policy.row.taxInclusive),
      taxRate: Number(policy.row.taxRate),
      currency: quote.currency,
      steps: quote.steps,
      policy: { id: policy.row.id, code: policy.row.code, name: policy.row.name, version: policy.row.version, method: policy.row.method },
      zone: match === null ? null : { id: match.zone.id, code: match.zone.code, name: match.zone.name, by: match.by },
      route: quote.basis.km === null ? null : { km: quote.basis.km, minutes: quote.basis.minutes, provider, degraded, approximate },
      considered,
    };
  }
}
