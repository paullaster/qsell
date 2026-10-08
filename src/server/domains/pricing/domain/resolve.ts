import {
  SCOPE_DIMENSIONS,
  SCOPE_LABELS,
  type PriceContext,
  type PriceItemInput,
  type PriceListHeader,
  type PriceListLine,
  type PriceResult,
  type PriceTrace,
  type QuantityMode,
  type ScopeDimension,
  type Scopes,
  type SpecificityWeights,
  type Tier,
  type TraceCandidate,
} from './types';

/** Longest candidate list kept on a trace; a document line must not carry thousands. */
const MAX_TRACED = 25;

export const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

const money = (value: number, digits: number) =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

/** The sum of the weights of the dimensions the list limits with `in`, plus the contract weight. */
export function specificityOf(header: PriceListHeader, weights: SpecificityWeights): number {
  let total = header.kind === 'contract' ? weights.contract : 0;
  for (const d of SCOPE_DIMENSIONS) {
    const rule = header.scopes[d];
    if (rule?.op === 'in' && rule.values.length > 0) total += weights[d];
  }
  return total;
}

function contextValue(ctx: PriceContext, d: ScopeDimension): string | null | undefined {
  switch (d) {
    case 'customer':
      return ctx.customerId;
    case 'customer_group':
      return ctx.customerGroupId;
    case 'route':
      return ctx.route;
    case 'branch':
      return ctx.branchId;
    case 'sales_type':
      return ctx.salesType;
    case 'channel':
      return ctx.channel;
    case 'country':
      return ctx.country?.toUpperCase();
  }
}

/** Does the sale fall inside the list's scopes? On a miss, says which dimension failed. */
export function scopeMismatch(scopes: Scopes, ctx: PriceContext): string | null {
  for (const d of SCOPE_DIMENSIONS) {
    const rule = scopes[d];
    if (!rule || rule.values.length === 0) continue;
    const have = contextValue(ctx, d);
    const listed = d === 'country' ? rule.values.map((v) => v.toUpperCase()) : rule.values;
    const hit = have != null && have !== '' && listed.includes(have);
    if (rule.op === 'in' && !hit) return `Only for a different ${SCOPE_LABELS[d].toLowerCase()}`;
    if (rule.op === 'not_in' && hit) return `Excludes this ${SCOPE_LABELS[d].toLowerCase()}`;
  }
  return null;
}

const between = (at: Date, from: Date, to: Date | null) =>
  at.getTime() >= from.getTime() && (to === null || at.getTime() < to.getTime());

/**
 * The price of `qty` units from a price line and its quantity breaks.
 *  - all units: the highest tier reached prices every unit;
 *  - incremental: each tier prices only the units from its start onward (a tier starting at 51
 *    prices the 51st unit and up), the line's own price covers the units before the first tier.
 */
export function priceFromTiers(
  line: Pick<PriceListLine, 'price' | 'tiers'>,
  mode: QuantityMode,
  qty: number,
): { total: number; note: string | null } {
  const tiers = [...line.tiers].sort((a, b) => a.fromQty - b.fromQty);
  if (tiers.length === 0) return { total: line.price * qty, note: null };
  if (mode === 'all_units') {
    let hit: Tier | null = null;
    for (const t of tiers) if (qty >= t.fromQty) hit = t;
    return hit
      ? { total: hit.price * qty, note: `the ${hit.fromQty}+ unit tier prices every unit` }
      : { total: line.price * qty, note: null };
  }
  const bounds = [
    { from: 1, price: line.price },
    ...tiers.map((t) => ({ from: t.fromQty, price: t.price })),
  ];
  let total = 0;
  const parts: string[] = [];
  bounds.forEach((b, i) => {
    const next = bounds[i + 1];
    const lastUnit = next ? Math.min(qty, next.from - 1) : qty;
    const units = Math.max(0, lastUnit - (b.from - 1));
    if (units > 0) {
      total += units * b.price;
      parts.push(`${units} at ${b.price}`);
    }
  });
  return { total, note: `units priced in steps: ${parts.join(', ')}` };
}

interface Pair {
  header: PriceListHeader;
  line: PriceListLine;
}

/** Turns an amount held in one tax basis into the document line's basis. */
function toLineBasis(amount: number, fromInclusive: boolean, toInclusive: boolean, rate: number) {
  if (fromInclusive === toInclusive || !(rate > 0)) return amount;
  return fromInclusive ? amount / (1 + rate / 100) : amount * (1 + rate / 100);
}

/**
 * Chooses the base price of one line. Pure: the same inputs always give the same answer, and the
 * answer carries the reasons. `pairs` are every active price list line for the product, whether
 * or not it applies; the engine decides, so the trace can say why each did or did not.
 *
 * Order of choice: most specific scope, then list priority, then newest start, then lowest id.
 * A list in the sale's currency beats a conversion from the base currency; with neither, the
 * product's standard price (converted if needed); with none of those the line cannot be priced.
 */
export function resolvePrice(
  item: PriceItemInput,
  ctx: PriceContext,
  pairs: Pair[],
  weights: SpecificityWeights,
): PriceResult {
  const digits = ctx.decimals;
  const candidates: TraceCandidate[] = [];
  const eligible: Array<Pair & { specificity: number; start: number; converted: boolean }> = [];
  const steps: string[] = [];

  for (const p of pairs) {
    const { header, line } = p;
    const specificity = specificityOf(header, weights);
    const base: Omit<TraceCandidate, 'outcome' | 'why'> = {
      source: 'price_list',
      listId: header.id,
      listCode: header.code,
      listVersion: header.version,
      lineId: line.id,
      specificity,
      priority: header.priority,
    };
    const reject = (why: string) => candidates.push({ ...base, outcome: 'not_applicable', why });
    if (!between(ctx.at, header.validFrom, header.validTo)) {
      reject('The price list is not in force on this date');
      continue;
    }
    if (!between(ctx.at, line.validFrom, line.validTo)) {
      reject('This price is not in force on this date');
      continue;
    }
    const miss = scopeMismatch(header.scopes, ctx);
    if (miss) {
      reject(miss);
      continue;
    }
    const sameCurrency = header.currency === ctx.currency;
    const convertible = header.currency === ctx.baseCurrency && ctx.rateFromBase > 0;
    if (!sameCurrency && !convertible) {
      reject(`Priced in ${header.currency}, the sale is in ${ctx.currency}`);
      continue;
    }
    eligible.push({
      ...p,
      specificity,
      start: Math.max(header.validFrom.getTime(), line.validFrom.getTime()),
      converted: !sameCurrency,
    });
  }

  // A list in the sale's own currency always beats a conversion.
  const inCurrency = eligible.filter((e) => !e.converted);
  const pool = inCurrency.length > 0 ? inCurrency : eligible;
  pool.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      b.header.priority - a.header.priority ||
      b.start - a.start ||
      a.header.id.localeCompare(b.header.id) ||
      a.line.id.localeCompare(b.line.id),
  );
  const winner = pool[0];

  const inputs: PriceTrace['inputs'] = {
    productId: item.productId,
    quantity: item.quantity,
    currency: ctx.currency,
    customerId: ctx.customerId ?? null,
    customerGroupId: ctx.customerGroupId ?? null,
    branchId: ctx.branchId ?? null,
    salesType: ctx.salesType ?? null,
    channel: ctx.channel ?? null,
    route: ctx.route ?? null,
    country: ctx.country ?? null,
  };
  const finish = (
    source: PriceTrace['source'],
    unit: number | null,
    total: number | null,
    extra: Partial<PriceTrace> = {},
  ): PriceResult => {
    // The winner first, then the near misses, then the lists that did not apply.
    const rank = { won: 0, lost: 1, not_applicable: 2 } as const;
    const ordered = [...candidates].sort((a, b) => rank[a.outcome] - rank[b.outcome]);
    const kept = ordered.slice(0, MAX_TRACED);
    if (ordered.length > kept.length)
      steps.push(`${ordered.length - kept.length} more price lists were considered.`);
    const trace: PriceTrace = {
      engineVersion: 1,
      at: ctx.at.toISOString(),
      inputs,
      candidates: kept,
      steps,
      source,
      unitPrice: unit,
      lineTotal: total,
      ...extra,
    };
    return { unitPrice: unit, lineTotal: total, trace };
  };

  if (!(item.quantity > 0)) {
    steps.push('The quantity must be above zero, so no price was worked out.');
    return finish('none', null, null);
  }

  pool.forEach((e, i) => {
    const cmp = i === 0 ? null : pool[0]!;
    let why = 'Chosen';
    if (cmp) {
      if (e.specificity !== cmp.specificity)
        why = `Less specific (${e.specificity}) than the chosen list (${cmp.specificity})`;
      else if (e.header.priority !== cmp.header.priority)
        why = `Same specificity, lower priority (${e.header.priority} against ${cmp.header.priority})`;
      else if (e.start !== cmp.start) why = 'Same priority, but an older price';
      else why = 'Equal in every respect; the chosen list was taken by its reference';
    }
    candidates.push({
      source: 'price_list',
      listId: e.header.id,
      listCode: e.header.code,
      listVersion: e.header.version,
      lineId: e.line.id,
      specificity: e.specificity,
      priority: e.header.priority,
      outcome: i === 0 ? 'won' : 'lost',
      why,
    });
  });
  if (inCurrency.length > 0 && eligible.length > inCurrency.length) {
    steps.push(`A price in ${ctx.currency} was used, so conversions were not considered.`);
  }

  // Works the chosen amount out: tiers, then currency, then tax basis, then rounding.
  const settle = (
    perUnitOrTotal: { total: number; note: string | null },
    heldInclusive: boolean,
    converted: boolean,
    floor: number | null,
  ) => {
    let total = perUnitOrTotal.total;
    let flo = floor;
    if (converted) {
      total *= ctx.rateFromBase;
      if (flo != null) flo *= ctx.rateFromBase;
      steps.push(`Converted from ${ctx.baseCurrency} at ${ctx.rateFromBase} to ${ctx.currency}.`);
    }
    const before = total;
    total = toLineBasis(total, heldInclusive, item.lineTaxInclusive, item.taxRate);
    if (flo != null) flo = toLineBasis(flo, heldInclusive, item.lineTaxInclusive, item.taxRate);
    if (total !== before) {
      steps.push(
        heldInclusive
          ? `The price is tax-inclusive; ${item.taxRate}% tax was taken off to match the line.`
          : `The price is tax-exclusive; ${item.taxRate}% tax was added to match the line.`,
      );
    }
    const unitExact = total / item.quantity;
    const lineTotal = round(unitExact * item.quantity, digits);
    return {
      unit: round(unitExact, 4),
      total: lineTotal,
      floor: flo == null ? null : round(flo / item.quantity, 4),
    };
  };

  if (winner) {
    const { header, line } = winner;
    const tiered = priceFromTiers(line, header.quantityMode, item.quantity);
    steps.push(
      `Price list ${header.code} (version ${header.version}) was chosen: ${money(line.price, digits)} ${header.currency}` +
        (tiered.note ? `, ${tiered.note}` : '') +
        '.',
    );
    const out = settle(
      tiered,
      header.taxInclusive,
      winner.converted,
      line.floorPrice == null ? null : line.floorPrice * item.quantity,
    );
    steps.push(
      `Price: ${money(out.unit, digits)} each, ${money(out.total, digits)} for ${item.quantity}.`,
    );
    return finish('price_list', out.unit, out.total, {
      winner: {
        listId: header.id,
        listCode: header.code,
        listVersion: header.version,
        lineId: line.id,
        listKind: header.kind,
      },
      floorPrice: out.floor,
      belowFloor: out.floor != null && out.unit < out.floor,
    });
  }

  const listed = pairs.length;
  if (item.standardPrice != null && Number.isFinite(item.standardPrice) && item.standardPrice > 0) {
    const std = item.standardPrice;
    const converted = ctx.currency !== ctx.baseCurrency;
    if (converted && !(ctx.rateFromBase > 0)) {
      steps.push(`There is no exchange rate from ${ctx.baseCurrency} to ${ctx.currency}.`);
      return finish('none', null, null);
    }
    candidates.push({
      source: 'standard',
      specificity: 0,
      priority: 0,
      outcome: 'won',
      why:
        listed > 0
          ? 'No price list applied to this sale, so the standard price was used'
          : 'The product is in no price list, so the standard price was used',
    });
    steps.push(
      listed > 0
        ? `No price list applied (${listed} considered); the standard price ${money(std, digits)} was used.`
        : `The product is in no price list; the standard price ${money(std, digits)} was used.`,
    );
    const out = settle(
      { total: std * item.quantity, note: null },
      item.standardTaxInclusive,
      converted,
      null,
    );
    steps.push(
      `Price: ${money(out.unit, digits)} each, ${money(out.total, digits)} for ${item.quantity}.`,
    );
    return finish('standard', out.unit, out.total);
  }

  steps.push(
    listed > 0
      ? `No price: none of the ${listed} price lists with this product applied, and it has no standard price.`
      : 'No price: the product is in no price list and has no standard price.',
  );
  return finish('none', null, null);
}

/** The customer's winning group: highest priority, then by code, so it is always the same one. */
export function chooseGroup(
  groups: Array<{ id: string; code: string; priority: number }>,
): string | null {
  if (groups.length === 0) return null;
  return [...groups].sort((a, b) => b.priority - a.priority || a.code.localeCompare(b.code))[0]!.id;
}
