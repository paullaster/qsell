'use server';

import { headers } from 'next/headers';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { readBasketItems, type BasketItem } from '@/lib/basket-items';
import { previewShopBasket } from '@/server/domains/orders/basket-preview';
import { parseCouponCodes } from '@/lib/checkout-input';
import { readGeoPoint, type GeoPoint } from '@/lib/geo';
import { clientAddress, waitMessage, type RateRuleName } from '@/lib/rate-limit';
import { isRecord } from '@/lib/values';
import type { AddressWords } from '@/lib/delivery-zones';
import { choosePolicy } from './domain/select';
import { leadTimeWords } from '@/lib/delivery-methods';
import { shopOffer, type ShopSlotOffer } from '@/lib/delivery-slot';
import { toHeader } from './charge-policies';
import type { PayOnDeliveryOffer } from '@/lib/pay-on-delivery';

/** Whether the checkout may offer "Pay on delivery", and the largest order taken that way. Public: it says nothing private. */
export async function payOnDeliveryOfferAction(): Promise<ShopResult<PayOnDeliveryOffer>> {
  try {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    return { ok: true, data: await c.doorPayments.payOnDeliveryOffer(company.id) };
  } catch (error) {
    console.error('[delivery] pay on delivery offer', error);
    return { ok: false, error: 'Pay on delivery could not be checked just now.' };
  }
}

/** What the shop's delivery section answers: data, never a thrown error (a server action's error text is hidden in production). */
export type ShopResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function limited(rule: RateRuleName): Promise<string | null> {
  const h = await headers();
  const verdict = await getContainer().rateLimits.hit(rule, clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  return verdict.allowed ? null : waitMessage(verdict.retryAfterSeconds);
}

const word = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);

function pointOf(raw: unknown): GeoPoint | null {
  if (!isRecord(raw)) return null;
  const read = readGeoPoint(raw.latitude, raw.longitude);
  return read.ok ? read.point : null;
}

/** The words of a delivery address the way the zones are written: county, town, estate or area. */
function addressWordsOf(raw: unknown): AddressWords | undefined {
  if (!isRecord(raw)) return undefined;
  const county = word(raw.county, 100);
  const town = word(raw.town, 100);
  const area = word(raw.area, 100);
  return county === null && town === null && area === null ? undefined : { county, town, area };
}

export interface ShopDeliveryOptions {
  /** How the browser draws the map, or null when this shop's map service has none (people then write the address or share their location). */
  clientMap: { driver: string; options: Record<string, string> } | null;
  canSearch: boolean;
  /** May be searched on every keystroke. When it may not, the shopper presses Search. */
  typeahead: boolean;
  canReverse: boolean;
  /** Where the map opens: the middle of the branches that have a pin, else Nairobi. */
  centre: GeoPoint;
  /** The ways the shop gets an order to the customer (a branch offers each; collection needs no charge policy). */
  methods: ('own_fleet' | 'courier' | 'pickup')[];
}

/** Public: what the delivery section can offer in this shop. */
export async function shopDeliveryOptionsAction(): Promise<ShopResult<ShopDeliveryOptions>> {
  try {
    const { geo, companySettings, branches: branchRepo, deliveryMethods, chargePolicies } = getContainer();
    const company = await companySettings.ensureSeeded();
    const [caps, rows] = await Promise.all([geo.capabilities(), branchRepo.listByCompany(company.id)]);
    const active = rows.filter((b) => b.isActive);
    const pins = active.flatMap((b) => (b.latitude !== null && b.longitude !== null ? [{ latitude: b.latitude, longitude: b.longitude }] : []));
    const centre = pins.length === 0 ? { latitude: -1.2921, longitude: 36.8219 } : { latitude: pins.reduce((n, p) => n + p.latitude, 0) / pins.length, longitude: pins.reduce((n, p) => n + p.longitude, 0) / pins.length };
    const [offered, inForce] = await Promise.all([deliveryMethods.forBranches(company.id, active.map((b) => b.id)), chargePolicies.inForce(company.id)]);
    // The shop offers a way of delivering only where a branch really offers it AND a charge policy in force covers that branch for
    // the shop. A method switched on before its charges are set up must never stop anyone checking out.
    const headers = inForce.map((p) => toHeader(p.row));
    const at = new Date();
    const priced = new Set(active.filter((b) => choosePolicy(headers, { at, currency: 'KES', branchId: b.id, channel: 'ecommerce', salesType: 'cash' }).chosen !== null).map((b) => b.id));
    const delivered = (['own_fleet', 'courier'] as const).filter((m) => active.some((b) => priced.has(b.id) && (offered.get(b.id) ?? []).some((r) => r.method === m && r.isActive)));
    // Collecting costs nothing, so it needs a branch that offers it and no charge policy.
    const collect = active.some((b) => (offered.get(b.id) ?? []).some((r) => r.method === 'pickup' && r.isActive));
    const methods = collect ? [...delivered, 'pickup' as const] : delivered;
    return { ok: true, data: { clientMap: caps.clientMap, canSearch: caps.placeSearch, typeahead: caps.typeahead, canReverse: caps.reverseGeocode, centre, methods } };
  } catch (error) {
    console.error('[shop delivery] options', error);
    return { ok: false, error: 'Delivery options could not be loaded just now.' };
  }
}

export interface ShopPlace {
  id: string;
  label: string;
  secondary: string | null;
  point: GeoPoint;
}

/** Public: places that match what the shopper typed, only when they ask (the free map servers do not allow search as people type). */
export async function shopSearchPlacesAction(raw: unknown): Promise<ShopResult<ShopPlace[]>> {
  const q = isRecord(raw) ? word(raw.q, 120) : null;
  if (q === null || q.length < 3) return { ok: false, error: 'Type at least three letters of the place.' };
  const wait = await limited('shop_map_search_ip');
  if (wait !== null) return { ok: false, error: wait };
  const found = await getContainer().geo.searchPlaces(q, { limit: 6 });
  return { ok: true, data: found.value.flatMap((p) => (p.point === null ? [] : [{ id: p.id, label: p.label, secondary: p.secondary, point: p.point }])) };
}

export interface ShopPinPlace {
  label: string;
  county: string | null;
  town: string | null;
  area: string | null;
  road: string | null;
}

/** Public: the address of a pin the shopper dropped, to fill the written address for them to check. Null when the map service has none. */
export async function shopNamePinAction(raw: unknown): Promise<ShopResult<ShopPinPlace | null>> {
  const point = pointOf(raw);
  if (point === null) return { ok: false, error: 'That is not a place on the map.' };
  const wait = await limited('shop_map_search_ip');
  if (wait !== null) return { ok: false, error: wait };
  const named = await getContainer().geo.reverse(point);
  const p = named.value;
  return { ok: true, data: p === null ? null : { label: p.label, county: p.county, town: p.town, area: p.area, road: p.road } };
}

function cautionOf(guess: boolean, estimated: boolean): string | null {
  if (guess) return 'The distance is worked out from the area you wrote, so it is a guess. Drop a pin for an exact charge.';
  return estimated ? 'The distance is an estimate of the road, not a measured road.' : null;
}

export interface ShopDeliveryQuote {
  method: 'own_fleet' | 'courier' | 'pickup';
  branchName: string;
  why: string;
  /** What the customer pays for delivery, with its parts. */
  gross: number;
  net: number;
  tax: number;
  taxRate: number;
  currency: string;
  km: number | null;
  approximate: boolean;
  zone: string | null;
  /** How the charge was worked out, line by line. */
  steps: { label: string; amount: number }[];
  /** Said when the distance is a guess (a written address placed on the map, or the built-in estimate). */
  caution: string | null;
}

type ShopPlanned = { ok: true; plan: Extract<Awaited<ReturnType<ReturnType<typeof getContainer>['deliveryPlans']['plan']>>, { ok: true }>; method: 'own_fleet' | 'courier' | 'pickup'; companyId: string; lines: BasketItem[] } | { ok: false; error: string };

/** What the basket and place the browser sent come to on the server: the branch, the charge and the goods. Shared by the price and the delivery times. */
async function planShopDelivery(raw: unknown): Promise<ShopPlanned> {
  if (!isRecord(raw)) return { ok: false, error: 'Your delivery could not be read.' };
  const method = raw.method === 'courier' || raw.method === 'pickup' ? raw.method : 'own_fleet';
  const pin = method === 'pickup' ? null : pointOf(raw.pin);
  const address = method === 'pickup' ? undefined : addressWordsOf(raw.address);
  const pickupBranchId = method === 'pickup' && typeof raw.pickupBranchId === 'string' && raw.pickupBranchId.length <= 100 ? raw.pickupBranchId : null;
  if (method === 'pickup' && pickupBranchId === null) return { ok: false, error: 'Choose the branch you will collect from.' };
  if (method !== 'pickup' && pin === null && address === undefined) return { ok: false, error: 'Drop a pin on the map or write your area, so we can tell what delivery costs.' };
  const lines = readBasketItems(raw.items);
  if (lines === null || lines.length === 0) return { ok: false, error: 'Your basket could not be read.' };
  const wait = await limited('shop_delivery_quote_ip');
  if (wait !== null) return { ok: false, error: wait };
  const session = await auth();
  const customerId = session?.user.customerStoreId ?? null;
  const coupons = parseCouponCodes(raw.couponCodes);
  const basket = await previewShopBasket(lines, customerId, { couponCodes: coupons.ok ? coupons.value : [] });
  if (!basket.ok) return { ok: false, error: basket.error };
  const { deliveryPlans, pricing, companySettings } = getContainer();
  const company = await companySettings.ensureSeeded();
  const country = isRecord(raw.address) ? word(raw.address.country, 100) : null;
  const plan = await deliveryPlans.plan(company.id, {
    at: new Date(),
    currency: basket.currency,
    channel: 'ecommerce',
    method,
    ...(pickupBranchId === null ? {} : { pickupBranchId }),
    lines: basket.stockLines,
    customerId,
    customerGroupId: await pricing.groupFor(company.id, customerId),
    salesType: 'cash',
    country,
    ...(address === undefined ? {} : { address }),
    pin,
    weightKg: basket.weightKg,
    orderValue: basket.goodsTotal,
  });
  if (!plan.ok) return { ok: false, error: plan.message };
  return { ok: true, plan, method, companyId: company.id, lines };
}

/**
 * Public: what delivering this basket to this pin or address costs, and from which branch. Worked out here from the shop's own
 * prices, stock and policies; the browser supplies only the basket's product ids and quantities and where it is going.
 */
export async function shopQuoteDeliveryAction(raw: unknown): Promise<ShopResult<ShopDeliveryQuote>> {
  try {
    const planned = await planShopDelivery(raw);
    if (!planned.ok) return { ok: false, error: planned.error };
    const { plan, method } = planned;
    const q = plan.quote;
    const guess = q.route?.approximate === true || plan.destination.approximate;
    const estimated = q.route !== null && q.route.provider === 'builtin';
    return {
      ok: true,
      data: {
        method,
        branchName: plan.branch.name,
        why: plan.choice.words,
        gross: q.split.gross,
        net: q.split.net,
        tax: q.split.tax,
        taxRate: q.taxRate,
        currency: q.currency,
        km: q.route?.km ?? null,
        approximate: guess,
        zone: q.zone?.name ?? null,
        steps: q.steps.map((s) => ({ label: s.label, amount: s.amount })),
        caution: cautionOf(guess, estimated),
      },
    };
  } catch (error) {
    console.error('[shop delivery] quote', error);
    return { ok: false, error: 'We could not work out your delivery just now. Please try again.' };
  }
}

/**
 * Public: the delivery times this basket can be given, and the earliest. The branch, the zone and the goods are worked out here, the same way
 * as the price; the browser supplies only the basket and the place. Collecting from a branch has no delivery times.
 */
export async function shopDeliverySlotsAction(raw: unknown): Promise<ShopResult<ShopSlotOffer>> {
  if (isRecord(raw) && raw.method === 'pickup') return { ok: true, data: { days: [], earliest: null } };
  try {
    const planned = await planShopDelivery(raw);
    if (!planned.ok) return { ok: false, error: planned.error };
    if (planned.method === 'pickup') return { ok: true, data: { days: [], earliest: null } };
    const { plan, companyId, lines } = planned;
    // A company that plans every delivery itself shows no times at all: the checkout hides the section when there are none.
    if (!(await getContainer().deliverySlots.shopperChoice(companyId)).enabled) return { ok: true, data: { days: [], earliest: null } };
    const zone = plan.quote.zone;
    const days = await getContainer().deliverySlots.offer(companyId, { branchId: plan.branch.id, days: 10, basket: { method: planned.method, zone: zone === null ? null : { id: zone.id, name: zone.name }, lines } });
    return { ok: true, data: shopOffer(days) };
  } catch (error) {
    console.error('[shop delivery] slots', error);
    return { ok: false, error: 'The delivery times could not be loaded just now.' };
  }
}

export interface ShopPickupPoint {
  branchId: string;
  name: string;
  address: string;
  phone: string | null;
  landmark: string | null;
  /** How long the branch needs to get the order ready, in words. */
  ready: string;
  note: string | null;
  /** Whether the branch has everything in the basket now; one that does not cannot be chosen. */
  holdsAll: boolean;
}

/**
 * Public: the branches this basket can be collected from, with their address, phone and how soon the order is ready. The browser
 * supplies only the basket's product ids and quantities; which branches offer collection and hold the goods is the server's answer.
 */
export async function shopPickupPointsAction(raw: unknown): Promise<ShopResult<ShopPickupPoint[]>> {
  if (!isRecord(raw)) return { ok: false, error: 'Your basket could not be read.' };
  const lines = readBasketItems(raw.items);
  if (lines === null || lines.length === 0) return { ok: false, error: 'Your basket could not be read.' };
  const wait = await limited('shop_delivery_quote_ip');
  if (wait !== null) return { ok: false, error: wait };
  try {
    const session = await auth();
    const basket = await previewShopBasket(lines, session?.user.customerStoreId ?? null);
    if (!basket.ok) return { ok: false, error: basket.error };
    const { deliveryPlans, companySettings } = getContainer();
    const company = await companySettings.ensureSeeded();
    const points = await deliveryPlans.pickupPoints(company.id, { lines: basket.stockLines, channel: 'ecommerce' });
    return {
      ok: true,
      data: points.map((p) => ({ branchId: p.branchId, name: p.name, address: p.address, phone: p.phone, landmark: p.landmark, ready: leadTimeWords(p.leadTimeMinutes), note: p.note, holdsAll: p.holdsAll })),
    };
  } catch (error) {
    console.error('[shop delivery] pickup points', error);
    return { ok: false, error: 'The branches you can collect from could not be loaded just now.' };
  }
}
