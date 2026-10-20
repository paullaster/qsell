/**
 * Kits and hampers: one product that is really several. It is sold, priced and discounted as a
 * single line; when the sale is saved it becomes one line per component, each with its share of
 * the price. That is what lets stock leave per component, each component carry its own tax rate
 * and tax class, and a partial return credit the right amount.
 */
import { quantityFits } from '@/lib/decimal';


export type KitAllocation = 'list_price' | 'cost' | 'explicit';

export const KIT_ALLOCATIONS: Array<{ value: KitAllocation; label: string; help: string }> = [
  {
    value: 'list_price',
    label: "In proportion to the components' prices",
    help: 'Each component takes a share of the kit price matching its own selling price.',
  },
  {
    value: 'cost',
    label: "In proportion to the components' cost",
    help: 'Each component takes a share matching what it costs you.',
  },
  {
    value: 'explicit',
    label: 'In shares you set',
    help: 'You give each component a share; the kit price is split in those proportions.',
  },
];

export const MAX_KIT_COMPONENTS = 50;

export interface KitComponentDef {
  productId: string;
  /** Units of this component in one kit. */
  quantity: number;
  /** The component's own selling price and cost, per unit, for the proportional methods. */
  price: number;
  cost: number;
  /** For the explicit method: this component's share (any positive number). */
  weight: number | null;
}

export interface KitPart {
  productId: string;
  /** Units for the whole sale (the component's quantity times the kit's). */
  quantity: number;
  /** This component's share of the kit's price. The parts add up to the price exactly. */
  amount: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Splits what a kit line came to across its components, to the cent. If the chosen basis is
 * unusable (every component's price is zero, say) the split falls back to units, so a component
 * is never left out of the sale.
 */
export function allocateKit(
  total: number,
  kitQuantity: number,
  components: KitComponentDef[],
  method: KitAllocation,
): KitPart[] {
  if (components.length === 0) return [];
  const basis = (c: KitComponentDef) =>
    method === 'explicit'
      ? (c.weight ?? 0)
      : method === 'cost'
        ? c.cost * c.quantity
        : c.price * c.quantity;
  let weights = components.map(basis);
  if (!(weights.reduce((n, w) => n + w, 0) > 0)) weights = components.map((c) => c.quantity);
  const sum = weights.reduce((n, w) => n + w, 0);

  // The last component with a share takes the cent that rounding leaves over.
  const lastWithShare = weights.reduce((last, w, i) => (w > 0 ? i : last), 0);
  let given = 0;
  return components.map((c, i) => {
    const amount =
      i === lastWithShare ? round2(total - given) : round2((total * weights[i]!) / sum);
    given = round2(given + amount);
    return {
      productId: c.productId,
      quantity: c.quantity * kitQuantity,
      amount: weights[i]! > 0 ? amount : 0,
    };
  });
}

/** What a part of a kit comes to net of tax and what the tax is, in the kit line's tax basis. */
export function splitTax(
  amount: number,
  taxRate: number,
  inclusive: boolean,
): { net: number; tax: number } {
  const rate = Math.max(0, taxRate);
  if (inclusive && rate > 0) {
    const net = amount / (1 + rate / 100);
    return { net, tax: amount - net };
  }
  return { net: amount, tax: amount * (rate / 100) };
}

export interface KitProblem {
  path: string;
  message: string;
}

/** Checks a kit's definition. A kit cannot contain itself, another kit, or the same component twice. */
export function checkKit(
  kitProductId: string,
  method: KitAllocation,
  components: Array<Pick<KitComponentDef, 'productId' | 'quantity' | 'weight'>>,
  kitProductIds: ReadonlySet<string> = new Set(),
): KitProblem[] {
  const out: KitProblem[] = [];
  if (!KIT_ALLOCATIONS.some((a) => a.value === method))
    out.push({ path: 'allocation', message: 'Choose how the kit price is split.' });
  if (components.length === 0)
    out.push({ path: 'components', message: 'Add at least one component.' });
  if (components.length > MAX_KIT_COMPONENTS)
    out.push({
      path: 'components',
      message: `A kit can have at most ${MAX_KIT_COMPONENTS} components.`,
    });
  const seen = new Set<string>();
  components.forEach((c, i) => {
    if (c.productId === kitProductId)
      out.push({ path: `components.${i}`, message: 'A kit cannot contain itself.' });
    if (kitProductIds.has(c.productId))
      out.push({ path: `components.${i}`, message: 'A kit cannot contain another kit.' });
    if (seen.has(c.productId))
      out.push({
        path: `components.${i}`,
        message: 'The same product is listed twice. Add its units to one row.',
      });
    seen.add(c.productId);
    if (!(quantityFits(c.quantity, 3) && c.quantity > 0))
      out.push({
        path: `components.${i}`,
        message: 'Each component needs a quantity above zero, with at most 3 decimals.',
      });
    if (method === 'explicit' && !(c.weight != null && c.weight > 0))
      out.push({ path: `components.${i}`, message: 'Give every component a share above zero.' });
  });
  return out;
}

/** What pricing a kit needs to know: how its price is split, and its components' tax. */
export interface KitTaxShape {
  allocation: KitAllocation;
  components: Array<KitComponentDef & { taxRate: number }>;
}

/**
 * What a kit line comes to net of tax and the tax on it, summed over its components, each at its
 * own tax rate. The amount is in the kit line's basis.
 */
export function kitTax(
  amount: number,
  quantity: number,
  kit: KitTaxShape,
  inclusive: boolean,
): { net: number; tax: number } {
  const parts = allocateKit(amount, quantity, kit.components, kit.allocation);
  let net = 0;
  let tax = 0;
  for (const part of parts) {
    const comp = kit.components.find((c) => c.productId === part.productId)!;
    const s = splitTax(part.amount, comp.taxRate, inclusive);
    net += s.net;
    tax += s.tax;
  }
  return { net, tax };
}

/** What one kit costs: the cost of everything in it. */
export const kitCost = (kit: Pick<KitTaxShape, 'components'>): number =>
  kit.components.reduce((n, c) => n + c.cost * c.quantity, 0);
