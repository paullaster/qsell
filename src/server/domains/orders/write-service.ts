import { quantityProblem } from '@/lib/unit-rules';
import type { CheckoutRefusal, StageSource } from '@/lib/order-stages';
import { OrderStages, type StageActor } from './stages';
import { basketQuantityProblems } from '@/lib/quantity-limits';
import { priceItemFor } from '@/server/domains/pricing/service';
import { randomUUID } from 'node:crypto';
import type { Order, OrderItem, PaymentProvider } from '@/types/index';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { getContainer } from '@/server/di/container';
import { CatalogService } from '@/server/domains/catalog/service';
import { isSalesChannel } from '@/lib/stock';
import { InventoryReservationService, ONLINE_PAYMENT_METHODS } from '@/server/domains/inventory/reservation-service';
import { broadcastRealtime } from '@/server/realtime';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products as productsTable } from '@/server/db/drizzle/schema';
import { needsApprovalCheck } from './approval';
import type { PriceResult, PriceTrace } from '@/server/domains/pricing/domain/types';
import type { GuardLine } from '@/server/domains/pricing/guard-service';
import type {
  GiftLine,
  PricedItem,
  RuleApplication,
} from '@/server/domains/pricing/discount-service';
import { readOptionalEmail } from '@/lib/guest-contact';
import { has, nth, orElse, required } from '@/lib/values';
import { expandKits, KitError } from '@/server/domains/pricing/kit-service';
import { packagingSelectionProblem } from '@/lib/packaging-suggestions';
import { inventoryStockLines } from '@/lib/inventory-kind';
import type { DeliveryMethod } from '@/lib/delivery-methods';
import type { AddressWords } from '@/lib/delivery-zones';
import type { GeoPoint } from '@/lib/geo';
import type { PlanResult } from '@/server/domains/delivery/plan';

/** What one line costs: the quote's own figure, else what the price lists gave, else the standard price. */
export function lineAmounts(
  quoted: { lineAmount: number; quantity: number } | undefined,
  priced: PriceResult | undefined,
  standardPrice: number | null | undefined,
  quantity: number,
): { unitPrice: number; total: number } {
  if (quoted !== undefined) {
    return {
      unitPrice: quoted.lineAmount / (quoted.quantity > 0 ? quoted.quantity : 1),
      total: quoted.lineAmount,
    };
  }
  if (priced !== undefined) {
    const total = priced.lineTotal ?? 0;
    return { unitPrice: total / (quantity > 0 ? quantity : 1), total };
  }
  const unitPrice = standardPrice ?? 0;
  return { unitPrice, total: unitPrice * quantity };
}

/** Who placed an order and from where, for its first event: a shopper at the shop, staff at the till, staff in the office. */
function placedBy(channel: string, customerId: string | null, requestedBy: string | null): { source: StageSource; actor: StageActor } {
  if (channel === 'ecommerce') return { source: 'shop', actor: { type: 'customer', id: customerId } };
  return { source: channel === 'pos_cash_sale' ? 'pos' : 'staff', actor: { type: 'user', id: requestedBy } };
}

/** What the shopper is told when the database refused the order. */
const ORDER_NOT_SAVED = 'We could not place your order just now. Nothing has been charged. Please try again in a moment.';

/** What the shopper is told for a failed order: our own refusal as it is written, a database failure only in general words. */
function refusalMessage(error: unknown, failure: string | null): string {
  if (failure !== null) return ORDER_NOT_SAVED;
  return error instanceof Error ? error.message : 'Customer or dimension assignment failed';
}

/** The whole of a database failure (its message and the reason the database gave), or null when the error is not one. */
function databaseFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = error.cause instanceof Error ? error.cause : null;
  const isDatabase = error.name === 'DrizzleQueryError' || error.message.startsWith('Failed query:') || (cause !== null && 'code' in cause && typeof cause.code === 'string');
  if (!isDatabase) return null;
  const reason = cause === null ? '' : ` | reason: ${cause.message}${'detail' in cause && typeof cause.detail === 'string' ? ` (${cause.detail})` : ''}${'constraint_name' in cause && typeof cause.constraint_name === 'string' ? ` [constraint ${cause.constraint_name}]` : ''}`;
  return `${error.message}${reason}`;
}

/** The short reason a failed order creation is recorded with, from what went wrong. */
function refusalCodeOf(message: string): CheckoutRefusal {
  if (/credit limit/i.test(message)) return 'credit_limit';
  if (/approval/i.test(message)) return 'approval_needed';
  return 'other';
}

export const OrderWriteService = {
  async createOrder(raw: {
    userId?: string | null;
    branchId?: string | null;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    /** The customer's own record, when the buyer is signed in: the price lists meant for them apply. */
    customerId?: string | null;
    /** When the shopper started this checkout, for the order's timeline. */
    checkoutStartedAt?: Date | null;
    /** The number the customer pays from, when it is not the contact number. */
    paymentPhone?: string | null;
    buyerKraPin?: string | null;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      postalCode?: string;
      country: string;
    };
    items: { productId: string; quantity: number }[];
    quotedItems?: {
      productId: string;
      quantity: number;
      productName: string;
      sku: string;
      lineAmount: number;
      taxRate: number;
      isTaxInclusive: boolean;
      /** Why the quote priced it as it did; carried onto the order line. */
      priceTrace?: PriceTrace | null;
      /** A free gift the quote added, carried across as it was. */
      isGift?: boolean;
      /** The unit the quote line was typed in, carried across as it was. */
      unitId?: string | null;
      unitCode?: string | null;
      enteredQuantity?: number | null;
      qtyPerUnit?: string | null;
      enteredUnitPrice?: number | null;
    }[];
    quotedTotals?: { subtotal: number; tax: number; shippingFee: number; totalAmount: number };
    /**
     * To have the order delivered: how, and where to (a map pin, a written address, or both). The branch that processes it and the
     * charge are decided here on the server, never taken from the caller; the charge becomes the order's shipping fee.
     */
    delivery?: {
      method: DeliveryMethod;
      /** For collection from a branch: the branch the customer chose. It is checked here: it must offer collection and hold the goods. */
      pickupBranchId?: string | null;
      pin?: GeoPoint | null;
      address?: AddressWords;
      /** Who receives it, when that is not the buyer. */
      recipient?: { name: string; phone: string } | null;
      /** Anything the rider should know (the gate, the floor). */
      notes?: string | null;
      /** What delivery cost on the screen the shopper saw (tax included). If the charge worked out now is different, the order is refused so nobody pays an amount they were not shown. */
      expectedCharge?: number | null;
      /** The delivery time the shopper chose. Checked against the slot's rules here; kept with the order and booked when its delivery is made. */
      slot?: { slotId: string; day: string } | null;
    };
    orderId?: string;
    orderNumber?: string;
    currency: 'KES' | 'USD';
    paymentMethod: PaymentProvider;
    /**
     * The invoicing module this sale belongs to. Defaults to the store. A sale on account is
     * always a credit sale, whatever channel it came through.
     */
    salesModule?: 'ecommerce' | 'sales_order' | 'pos_cash_sale';
    /**
     * The staff member placing the order. Orders on the sales-order and credit channels are sent
     * for approval when a workflow says so; without one (a shop checkout) they never are.
     */
    requestedBy?: string;
    /**
     * False when the buyer's identity is not proven (a shop guest who typed an email): a registered customer's card is then left as
     * it is, and a credit account cannot be used. Left out for staff and other callers, which are trusted.
     */
    identityVerified?: boolean;
    /** Coupon codes the customer gave. A code that cannot be used refuses the order, saying why. */
    couponCodes?: string[];
    /**
     * For an order made from a quote: the discounts the quote already applied. Their use is
     * recorded with the order; nothing is repriced.
     */
    discountApplications?: RuleApplication[];
    discountSummary?: Record<string, unknown>;
    /** Flat fields (globalDimension1Code) or { global, shortcut } projection */
    dimensionFields?:
      | Record<string, string | null | undefined>
      | {
          global: Record<string, string>;
          shortcut: Record<string, string>;
        };
  }): Promise<{ success: boolean; order?: Order; error?: string; /** Why it was refused, for the checkout attempt's record. */ code?: CheckoutRefusal }> {
    // A shopper may leave the email out; whatever is given is checked here, not trusted from the browser.
    const contact = readOptionalEmail(raw.customerEmail);
    if (!contact.ok) return { success: false, error: contact.error, code: 'invalid_input' };
    const params = { ...raw, customerEmail: contact.email };
    // A credit account is charged only for a buyer who has proven who they are (the shop passes `false` for anyone not signed in as
    // that customer; staff and other trusted callers leave it out).
    if (params.paymentMethod === 'on_account' && params.identityVerified === false) {
      return { success: false, error: 'On account is for customers who are signed in with their account email. Please sign in, or choose another way to pay.', code: 'credit_limit' };
    }
    const orderItems: OrderItem[] = [];
    const pricedLines: {
      productId: string;
      quantity: number;
      unitPrice: number;
      taxRate: number;
      isTaxInclusive: boolean;
    }[] = [];

    const catalogProducts = new Map(
      (await CatalogService.getProductsByIds(params.items.map((i) => i.productId))).map((p) => [
        p.id,
        p,
      ]),
    );
    if ((params.salesModule ?? 'ecommerce') === 'ecommerce') {
      const goods = params.items.flatMap((item) => {
        const product = catalogProducts.get(item.productId);
        return product !== undefined && product.isCheckoutPackaging !== true
          ? [{ productId: item.productId, quantity: item.quantity }]
          : [];
      });
      const selectedPackaging = params.items.flatMap((item) => {
        const product = catalogProducts.get(item.productId);
        return product?.isCheckoutPackaging === true ? [{ productId: item.productId, quantity: item.quantity }] : [];
      });
      if (selectedPackaging.length > 0) {
        const fitRows = await CatalogService.packagingFitsForProducts(goods.map((item) => item.productId));
        const problem = packagingSelectionProblem(goods, selectedPackaging, fitRows.map((fit) => ({
          productId: fit.productId,
          packagingProductId: fit.row.id,
          capacity: Number(fit.capacity),
        })));
        if (problem !== null) return { success: false, error: problem.message, code: problem.code };
      }
    }
    const quotedItems = new Map((params.quotedItems ?? []).map((item) => [item.productId, item]));

    // A quantity is counted in the product's unit: 2 pieces, 2.5 kg, never 2.5 pieces.
    for (const item of params.items) {
      const prod = catalogProducts.get(item.productId);
      if (prod === undefined) continue;
      const what = `Quantity of "${prod.name}"`;
      const problem =
        item.quantity > 0
          ? quantityProblem(item.quantity, prod.baseUnitDecimals, prod.baseUnitName, what)
          : `${what} must be above zero.`;
      if (problem !== null) return { success: false, error: problem, code: 'invalid_quantity' };
    }

    // The least and most of an item that may be bought are checked for every channel, over the whole document.
    const limitProblems = basketQuantityProblems(
      params.items.flatMap((item) => {
        const prod = catalogProducts.get(item.productId);
        return prod === undefined ? [] : [{ productId: item.productId, quantity: item.quantity, item: prod }];
      }),
    );
    if (limitProblems.length > 0) return { success: false, error: limitProblems.join(' '), code: 'quantity_limit' };

    // Every channel is priced by the pricing engine, the web shop included: what a shopper is shown is priced the same way, so
    // what they see is what they are charged. Discounts and coupons still apply to the staff channels only.
    const channel =
      params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce');
    const engine = new Map<number, PriceResult>();
    let saleCompanyId: string;
    let saleCustomerId: string | null;
    {
      const { companySettings, customers, pricing } = getContainer();
      const company = await companySettings.ensureSeeded();
      // The web shop trusts only the signed-in customer: an email typed into a form must never unlock another customer's prices.
      const known =
        params.customerId ??
        (channel === 'ecommerce' ? null : ((await customers.lookupByEmail(company.id, params.customerEmail))?.id ?? null));
      saleCompanyId = company.id;
      saleCustomerId = known;
      const toPrice: number[] = [];
      params.items.forEach((item, i) => {
        const prod = catalogProducts.get(item.productId);
        if (prod !== undefined && prod.isSellable && !quotedItems.has(item.productId))
          toPrice.push(i);
      });
      const priced = await pricing.priceLines(
        company.id,
        {
          customerId: known,
          branchId: params.branchId ?? null,
          salesType: channel === 'credit_sale' ? 'credit' : 'cash',
          channel,
        },
        toPrice.map((i) => {
          const item = nth(params.items, i);
          const prod = required(catalogProducts.get(item.productId), 'the product');
          return priceItemFor(prod, item.quantity);
        }),
      );
      toPrice.forEach((i, n) => engine.set(i, nth(priced, n)));
    }

    /** Lines the price lists priced: discounts apply to them, then they are checked against floors. */
    const guarded: {
      itemIndex: number;
      productId: string;
      label: string;
      quantity: number;
      taxRate: number;
      inclusive: boolean;
      priced: PriceResult;
    }[] = [];

    for (const [index, item] of params.items.entries()) {
      const prod = catalogProducts.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} does not exist.`, code: 'not_found' };
      }
      const quoted = quotedItems.get(item.productId);
      if (!prod.isSellable && !quoted) {
        return { success: false, error: `${prod.name} is not sellable and cannot be ordered.`, code: 'not_for_sale' };
      }
      // The web shop sells only what it shows; a staff order or a quote may still sell a product that is kept off the shop.
      if ((params.salesModule ?? 'ecommerce') === 'ecommerce' && !prod.showOnWebShop && !quoted) {
        return { success: false, error: `${prod.name} is not sold in the web shop.`, code: 'not_for_sale' };
      }
      const priced = engine.get(index);
      if (priced && priced.unitPrice == null) {
        return {
          success: false,
          error: `${prod.name} cannot be priced. ${priced.trace.steps.at(-1) ?? ''}`.trim(),
          code: 'cannot_be_priced',
        };
      }
      if (
        !quoted &&
        !priced &&
        (prod.price == null || !Number.isFinite(prod.price) || prod.price <= 0)
      ) {
        return { success: false, error: `${prod.name} has no valid selling price.`, code: 'cannot_be_priced' };
      }
      const { unitPrice, total: itemTotal } = lineAmounts(
        quoted,
        priced,
        prod.price,
        item.quantity,
      );
      // Promotions and coupons apply to every channel's price-list lines, the shop's included (price floors stay with the staff channels).
      if (priced && !quoted) {
        guarded.push({
          itemIndex: orderItems.length,
          productId: prod.id,
          label: prod.name,
          quantity: item.quantity,
          taxRate: Math.max(0, prod.taxRate ?? 0),
          inclusive: prod.isTaxInclusive !== false,
          priced,
        });
      }
      orderItems.push({
        productId: prod.id,
        productName: quoted?.productName ?? prod.name,
        sku: quoted?.sku ?? prod.sku,
        quantity: item.quantity,
        unitPrice,
        totalPrice: itemTotal,
        imageUrl: prod.imageUrl,
        priceTrace: quoted ? (quoted.priceTrace ?? null) : (priced?.trace ?? null),
        isGift: quoted?.isGift,
        // The unit a line was typed in; a line made from the product alone is in its base unit.
        unitId: quoted?.unitId ?? prod.baseUnitId,
        unitCode: quoted?.unitCode ?? prod.baseUnitCode,
        enteredQuantity: quoted?.enteredQuantity ?? null,
        qtyPerUnit: quoted?.qtyPerUnit ?? null,
        enteredUnitPrice: quoted?.enteredUnitPrice ?? null,
      });
      pricedLines.push({
        productId: prod.id,
        quantity: item.quantity,
        unitPrice,
        taxRate: quoted?.taxRate ?? prod.taxRate ?? 0,
        isTaxInclusive: quoted?.isTaxInclusive ?? prod.isTaxInclusive !== false,
      });
    }

    // Discounts: line rules, then order rules on what the lines now come to, then coupons. They
    // never take a line below its floor. The explanation of each line records what happened.
    let discountApplications: RuleApplication[] = [...(params.discountApplications ?? [])];
    let discountSummary: Record<string, unknown> | null = params.discountSummary ?? null;
    let gifts: GiftLine[] = [];
    if (guarded.length > 0 && has(saleCompanyId)) {
      const { discounts } = getContainer();
      const items: PricedItem[] = guarded.map((g) => ({
        productId: g.productId,
        quantity: g.quantity,
        unitPrice: nth(orderItems, g.itemIndex).unitPrice,
        lineTotal: nth(orderItems, g.itemIndex).totalPrice,
        taxRate: g.taxRate,
        lineTaxInclusive: g.inclusive,
        explicitFloorUnit: g.priced.trace.floorPrice ?? null,
        trace: g.priced.trace,
      }));
      const basket = await discounts.evaluate(
        saleCompanyId,
        {
          customerId: saleCustomerId,
          branchId: params.branchId ?? null,
          salesType: channel === 'credit_sale' ? 'credit' : 'cash',
          channel,
          paymentMethod: params.paymentMethod,
        },
        items,
        { couponCodes: params.couponCodes },
      );
      if (basket.couponProblems.length > 0) {
        const bad = nth(basket.couponProblems, 0);
        return { success: false, error: `Coupon ${bad.code}: ${bad.reason}`, code: 'coupon_refused' };
      }
      guarded.forEach((g, n) => {
        const b = nth(basket.lines, n);
        const item = nth(orderItems, g.itemIndex);
        if (b.lineDiscount + b.orderDiscount > 0) {
          item.unitPrice = b.unitPriceAfter;
          item.totalPrice = b.lineTotalAfter;
          nth(pricedLines, g.itemIndex).unitPrice = b.unitPriceAfter;
        }
        if (item.priceTrace && (b.trace.applied.length > 0 || b.trace.considered.length > 0))
          item.priceTrace = { ...item.priceTrace, discounts: b.trace };
      });
      discountApplications = [...discountApplications, ...basket.applications];
      gifts = basket.gifts;
      if (basket.totalDiscount > 0 || gifts.length > 0)
        discountSummary = {
          total: basket.totalDiscount,
          applications: basket.applications,
          couponCodes: (params.couponCodes ?? []).map((c) => c.trim().toUpperCase()),
          order: basket.orderApplied,
          gifts: gifts.map((g) => ({
            code: g.code,
            productId: g.productId,
            name: g.productName,
            quantity: g.quantity,
            value: g.value,
          })),
        };
    }

    // Price floors. A sale below a floor needs approval (or is refused outright by a "refuse"
    // floor). A till sale cannot wait for anyone, so it is refused. Measured after discounts.
    let floorBreach: { text: string; shortfallPercent: number } | null = null;
    if (guarded.length > 0 && channel !== 'ecommerce') {
      const { companySettings: cs, priceGuard } = getContainer();
      const companyForGuard = await cs.ensureSeeded();
      const guardLines: GuardLine[] = guarded.map((g) => {
        const toNet = (v: number) => (g.inclusive && g.taxRate > 0 ? v / (1 + g.taxRate / 100) : v);
        return {
          productId: g.productId,
          label: g.label,
          quantity: g.quantity,
          netUnit: toNet(nth(orderItems, g.itemIndex).unitPrice),
          explicitFloorNet:
            g.priced.trace.floorPrice != null ? toNet(g.priced.trace.floorPrice) : null,
        };
      });
      const verdict = await priceGuard.assess(
        companyForGuard.id,
        params.requestedBy ?? null,
        guardLines,
      );
      guarded.forEach((g, n) => {
        const item = nth(orderItems, g.itemIndex);
        if (item.priceTrace) item.priceTrace = { ...item.priceTrace, guard: nth(verdict.lines, n) };
      });
      if (verdict.blocked.length > 0) return { success: false, error: nth(verdict.blocked, 0), code: 'approval_needed' };
      if (verdict.belowFloor) {
        const first = required(
          guarded.find((_, n) => nth(verdict.lines, n).belowFloor),
          'the line below its floor',
        );
        const text = `${first.label} is priced below its floor.`;
        if (!needsApprovalCheck(channel, params.requestedBy))
          return {
            success: false,
            error: `${text} A sale at the till cannot wait for approval: change the price list, or sell it as a sales order.`,
            code: 'approval_needed',
          };
        floorBreach = { text, shortfallPercent: verdict.largestShortfallPercent };
      }
    }

    // Free gifts a promotion has earned join the order at no charge (stock is held for them too).
    for (const g of gifts) {
      orderItems.push({
        productId: g.productId,
        productName: `${g.productName} (free gift)`,
        sku: g.sku,
        quantity: g.quantity,
        unitPrice: 0,
        totalPrice: 0,
        imageUrl: g.imageUrl,
        isGift: true,
        priceTrace: {
          engineVersion: 1,
          at: new Date().toISOString(),
          inputs: { productId: g.productId, quantity: g.quantity, currency: params.currency },
          candidates: [],
          steps: [`A free gift from ${g.ruleName} (${g.code}), worth ${g.value.toFixed(2)}.`],
          source: 'none',
          unitPrice: 0,
          lineTotal: 0,
        },
      });
      pricedLines.push({
        productId: g.productId,
        quantity: g.quantity,
        unitPrice: 0,
        taxRate: 0,
        isTaxInclusive: true,
      });
    }

    // A kit is sold as one line but becomes one line per component: stock leaves per component,
    // each carries its own tax rate, and a partial return credits the right amount.
    const kitDefs = await getContainer().kits.forProducts(
      (await getContainer().companySettings.ensureSeeded()).id,
      orderItems.map((i) => i.productId),
      // Read fresh: a sale must never use a kit another server has just changed.
      { fresh: true },
    );
    if (kitDefs.size > 0) {
      const soldKit = orderItems.some((i) => kitDefs.has(i.productId));
      try {
        const expansion = expandKits(
          orderItems.map((item, i) => ({
            ...item,
            taxRate: nth(pricedLines, i).taxRate,
            isTaxInclusive: nth(pricedLines, i).isTaxInclusive,
          })),
          kitDefs,
          params.currency,
        );
        orderItems.splice(
          0,
          orderItems.length,
          ...expansion.lines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            sku: l.sku,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            totalPrice: l.totalPrice,
            imageUrl: l.imageUrl,
            priceTrace: l.priceTrace ?? null,
            isGift: l.isGift,
          })),
        );
        pricedLines.splice(
          0,
          pricedLines.length,
          ...expansion.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.quantity > 0 ? l.totalPrice / l.quantity : 0,
            taxRate: l.taxRate,
            isTaxInclusive: l.isTaxInclusive,
          })),
        );
      } catch (error) {
        if (error instanceof KitError) return { success: false, error: error.message, code: 'kit_error' };
        throw error;
      }
      // A quote's totals stand, but its kit lines are split by the kit as it is now. If the kit has changed since, the parts no
      // longer add up to what was quoted: refuse, so the quote is made again, rather than book parts that disagree with the total.
      if (soldKit && params.quotedTotals !== undefined) {
        const again = computeCheckoutTotals(pricedLines);
        if (Math.abs(again.subtotal - params.quotedTotals.subtotal) > 0.05 || Math.abs(again.tax - params.quotedTotals.tax) > 0.05) {
          return { success: false, error: 'A kit in this quote has changed since it was quoted, so its parts no longer add up to the quoted total. Please make the quote again.', code: 'kit_error' };
        }
      }
    }
    // Stock is held only for inventory-managed lines; service/non-inventory lines remain commercial order lines.
    const stockProductIds = [...new Set(orderItems.map((item) => item.productId))];
    const stockProductKinds = stockProductIds.length === 0 ? [] : await drizzleDb
      .select({ id: productsTable.id, inventoryKind: productsTable.inventoryKind })
      .from(productsTable)
      .where(inArray(productsTable.id, stockProductIds));
    if (stockProductKinds.length !== stockProductIds.length) {
      return { success: false, error: 'A product in your order could not be found.', code: 'not_found' };
    }
    const inventoryKindsById = new Map(stockProductKinds.map((product) => [product.id, product.inventoryKind]));
    const stockItems = inventoryStockLines(
      orderItems.map(({ productId, quantity }) => ({ productId, quantity })),
      inventoryKindsById,
    );

    const goodsTotals = params.quotedTotals ?? computeCheckoutTotals(pricedLines);
    const { subtotal, tax } = goodsTotals;
    const deliveryChannel = params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce');
    let delivered: Extract<PlanResult, { ok: true }> | null = null;
    if (params.delivery !== undefined) {
      const { deliveryPlans, pricing, companySettings: settings } = getContainer();
      const companyId = (await settings.ensureSeeded()).id;
      const weights = await drizzleDb
        .select({ id: productsTable.id, weight: productsTable.weight, inventoryKind: productsTable.inventoryKind })
        .from(productsTable)
        .where(inArray(productsTable.id, [...new Set(orderItems.map((i) => i.productId))]));
      const weightOf = new Map(weights.map((w) => [w.id, { weightKg: Number(w.weight ?? 0), inventoryKind: w.inventoryKind }]));
      const planned = await deliveryPlans.plan(companyId, {
        at: new Date(),
        currency: params.currency,
        channel: isSalesChannel(deliveryChannel) ? deliveryChannel : 'ecommerce',
        method: params.delivery.method,
        ...(params.delivery.pickupBranchId === undefined ? {} : { pickupBranchId: params.delivery.pickupBranchId }),
        lines: stockItems,
        customerId: params.customerId ?? null,
        customerGroupId: await pricing.groupFor(companyId, params.customerId),
        salesType: params.paymentMethod === 'on_account' ? 'credit' : 'cash',
        country: params.shippingAddress.country,
        ...(params.delivery.address === undefined ? {} : { address: params.delivery.address }),
        pin: params.delivery.pin ?? null,
        weightKg: orderItems.reduce((kg, item) => {
          const facts = weightOf.get(item.productId);
          return facts?.inventoryKind === 'service' ? kg : kg + (facts?.weightKg ?? 0) * item.quantity;
        }, 0),
        orderValue: subtotal + tax,
      });
      if (!planned.ok) return { success: false, error: planned.message, code: 'delivery_unavailable' };
      const expected = params.delivery.expectedCharge;
      if (expected !== undefined && expected !== null && Math.abs(expected - planned.quote.split.gross) > 0.005) {
        return { success: false, error: `The delivery charge is now ${planned.quote.split.gross.toFixed(2)} and not the ${expected.toFixed(2)} you were shown. Please look at your order again before you pay.`, code: 'delivery_changed' };
      }
      // The delivery time the shopper chose is looked at now, so a slot that has filled since they saw it is refused while they can still pick another.
      if (params.delivery.slot !== undefined && params.delivery.slot !== null && params.delivery.method !== 'pickup') {
        const refusal = await getContainer().deliverySlots.checkRequest(companyId, { branchId: planned.branch.id, basket: { method: params.delivery.method, zone: planned.quote.zone === null ? null : { id: planned.quote.zone.id, name: planned.quote.zone.name }, lines: orderItems.map((i) => ({ productId: i.productId, quantity: i.quantity })) }, slotId: params.delivery.slot.slotId, day: params.delivery.slot.day });
        if (refusal !== null) return { success: false, error: refusal, code: 'slot_unavailable' };
      }
      delivered = planned;
    }
    // An order to be collected is addressed to the branch, as the server knows it; the customer's own address is not touched.
    const orderAddress =
      delivered?.pickup === undefined
        ? params.shippingAddress
        : { street: `Collect at ${delivered.pickup.name}${delivered.pickup.street === null || delivered.pickup.street.trim() === '' ? '' : `, ${delivered.pickup.street.trim()}`}`, city: orElse(delivered.pickup.city?.trim(), delivered.pickup.name), countyOrState: delivered.pickup.county?.trim() ?? '', country: orElse(params.shippingAddress.country, 'Kenya') };
    // A delivered order is charged what the quote said; any other keeps the shipping its caller worked out.
    const shippingFee = delivered?.quote.split.net ?? goodsTotals.shippingFee;
    // Tax on the charge joins the order's tax, so the books, the invoice and the total all agree.
    const deliveryTax = delivered?.quote.split.tax ?? 0;
    const orderTax = Math.round((tax + deliveryTax) * 100) / 100;
    const totalAmount = delivered === null ? goodsTotals.totalAmount : Math.round((subtotal + orderTax + shippingFee) * 100) / 100;
    // Pay on delivery is for orders the shop's own rider takes, within the company's limit: checked here, on the priced order, before anything is held.
    if (params.paymentMethod === 'pay_on_delivery') {
      const { doorPayments, companySettings: settingsForDoor } = getContainer();
      const refusal = await doorPayments.checkPayOnDelivery((await settingsForDoor.ensureSeeded()).id, { deliveryMethod: params.delivery?.method ?? null, currency: params.currency, total: totalAmount });
      if (refusal !== null) return { success: false, error: refusal, code: 'pay_on_delivery' };
    }
    // The branch that processes a delivered order is the one chosen for it; stock is held from it first.
    const branchId = delivered?.branch.id ?? params.branchId;
    const orderId =
      // Unguessable: the id is the only key for a guest's invoice download.
      params.orderId ?? `ord_${randomUUID()}`;
    // The order number comes from the number series, assigned inside the transaction that saves
    // the order. A caller may still pass an explicit one (a typed-in number).
    const explicitOrderNumber = params.orderNumber;

    const salesModule = params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce');
    const reservation = await InventoryReservationService.reserveForOrder(
      stockItems,
      orderId,
      params.customerEmail,
      {
        channel: isSalesChannel(salesModule) ? salesModule : 'ecommerce',
        branchId: branchId ?? null,
        payNow: (ONLINE_PAYMENT_METHODS as readonly string[]).includes(params.paymentMethod),
      },
    );
    if (!reservation.success) {
      return { success: false, error: reservation.error, code: 'stock_short' };
    }

    // Customer persistence is handled by customers.prepareSale() below, which
    // resolves-or-creates the trade customer in Postgres along with the
    // delivery address. The old code kept a second, parallel CustomerAccount
    // Map here purely so db.getCustomerOrders() could find the order; that map
    // is gone, and order history is read from the orders table instead.
    let resolvedUserId = orElse(params.userId, '');

    const order: Order = {
      id: orderId,
      orderNumber: explicitOrderNumber ?? '',
      userId: resolvedUserId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      paymentPhone: params.paymentPhone ?? null,
      shippingAddress: orderAddress,
      items: orderItems,
      subtotal,
      tax: orderTax,
      shippingFee,
      totalAmount,
      currency: params.currency,
      status: 'pending',
      paymentStatus: 'unpaid',
      paymentMethod: params.paymentMethod,
      salesModule:
        params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce'),
      dimensionSetId: null,
      dimensionCodes: { global: {}, shortcut: {} },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      discounts: discountSummary,
    };

    const gated = needsApprovalCheck(order.salesModule, params.requestedBy);

    try {
      const { companySettings, dimensionSets, customers } = getContainer();
      const company = await companySettings.ensureSeeded();
      const onAccount = params.paymentMethod === 'on_account';
      const tradeCustomer = await customers.prepareSale({
        companyId: company.id,
        name: params.customerName,
        email: params.customerEmail,
        phone: params.customerPhone,
        address: params.shippingAddress,
        buyerKraPin: params.buyerKraPin,
        amount: totalAmount,
        onAccount,
        allowOverLimit: gated,
        updateExisting: params.identityVerified !== false || has(params.requestedBy),
      });
      const overCreditLimit =
        tradeCustomer.accountType === 'credit' &&
        Number(tradeCustomer.balance) + totalAmount > Number(tradeCustomer.creditLimit);
      // The trade customer is the durable identity for this order.
      if (!has(resolvedUserId)) resolvedUserId = tradeCustomer.id;
      const callerDimensions = params.dimensionFields;
      const hasCallerDimensions = (() => {
        if (!callerDimensions) return false;
        if ('global' in callerDimensions && 'shortcut' in callerDimensions) {
          const projection = callerDimensions as {
            global: Record<string, string>;
            shortcut: Record<string, string>;
          };
          return (
            Object.keys(projection.global).length + Object.keys(projection.shortcut).length > 0
          );
        }
        return Object.values(callerDimensions).some((value) => Boolean(value));
      })();
      const assignment = await dimensionSets.resolveAssignment(
        company.id,
        hasCallerDimensions ? required(callerDimensions) : tradeCustomer.dimensionCodes,
      );
      order.dimensionSetId = assignment.dimensionSetId;
      order.dimensionCodes = assignment.dimensionCodes;
      order.tradeCustomerId = tradeCustomer.id;
      order.customerAccountType = tradeCustomer.accountType as 'cash' | 'credit';
      order.transmitInvoicesToKra = tradeCustomer.transmitInvoicesToKra;
      // Whether it is signed is decided when its tax invoice is issued, by the signing
      // service, which then owns this status. 'pending' only means "not decided yet".
      order.kraTransmissionStatus = 'pending';

      const {
        orders: orderRepo,
        numbering,
        approvals,
        discounts: discountService,
        rebates,
        loyalty,
      } = getContainer();
      // What each unit cost today is kept with the sale, so its margin can be read years later.
      const costs = await drizzleDb
        .select({ id: productsTable.id, cost: productsTable.costPrice })
        .from(productsTable)
        .where(inArray(productsTable.id, [...new Set(orderItems.map((i) => i.productId))]));
      const costOf = new Map(costs.map((c) => [c.id, Number(c.cost)]));
      for (const item of orderItems) item.unitCost = costOf.get(item.productId) ?? null;
      await orderRepo.create(
        order,
        branchId,
        has(explicitOrderNumber)
          ? undefined
          : async (tx) =>
              (
                await numbering.assign(
                  'sales_order',
                  {
                    companyId: company.id,
                    branchId: branchId ?? null,
                    date: businessDate(),
                    document: { kind: 'sales_order', id: order.id },
                  },
                  tx,
                )
              ).number,
        async (tx, saved) => {
          if (delivered !== null && params.delivery !== undefined) {
            const actor = { type: 'user' as const, id: params.requestedBy ?? params.customerId ?? null };
            await getContainer().orderDeliveries.record(tx, { companyId: company.id, orderId: saved.id, method: params.delivery.method, plan: delivered, currency: params.currency, recipient: params.delivery.recipient ?? null, notes: params.delivery.notes ?? null, actor });
            if (params.delivery.slot !== undefined && params.delivery.slot !== null && params.delivery.method !== 'pickup') await getContainer().deliverySlots.recordRequest(tx, company.id, saved.id, params.delivery.slot, actor);
            // An order collected from a branch gets its code in the same transaction, so there is never one without the other.
            if (params.delivery.method === 'pickup') await getContainer().orderCollections.issue(tx, { companyId: company.id, orderId: saved.id, branchId: delivered.branch.id, actor });
            await OrderStages.moveIn(tx, saved.id, 'charge_quoted', 'succeeded', {
              ...placedBy(channel, params.customerId ?? null, params.requestedBy ?? null),
              ref: { type: 'delivery_quote', id: saved.id },
              message: delivered.choice.words,
              detail: { charge: delivered.quote.split.gross, tax: delivered.quote.split.tax, policy: delivered.quote.policy === null ? null : `${delivered.quote.policy.code} v${String(delivered.quote.policy.version)}`, branch: delivered.branch.code },
            });
          }
          // What the discounts used is recorded in the same transaction as the order.
          if (discountApplications.length > 0)
            await discountService.commit(
              tx,
              company.id,
              { type: 'order', id: saved.id, customerId: tradeCustomer.id },
              discountApplications,
            );
          // What the order is worth to the customer's rebates and loyalty points, likewise.
          const net = pricedLines.map((l) => {
            const total = l.unitPrice * l.quantity;
            return {
              productId: l.productId,
              net: l.isTaxInclusive ? total / (1 + Math.max(0, l.taxRate) / 100) : total,
            };
          });
          await rebates.accrueOrder(
            tx,
            { companyId: company.id, customerId: tradeCustomer.id, branchId },
            saved.id,
            net,
          );
          await loyalty.earnOrder(tx, {
            companyId: company.id,
            customerId: tradeCustomer.id,
            orderId: saved.id,
            spend: subtotal,
          });
          if (!gated) return;
          const outcome = await approvals.submit(
            {
              companyId: company.id,
              trigger: 'sales_order.submitted',
              documentId: saved.id,
              branchId: branchId ?? null,
              requestedBy: required(params.requestedBy, 'the staff member placing the order'),
              amount: totalAmount,
              snapshot: {
                salesModule: order.salesModule,
                belowFloor: floorBreach !== null,
                floorShortfallPercent: floorBreach?.shortfallPercent ?? 0,
                customer: {
                  id: tradeCustomer.id,
                  accountType: tradeCustomer.accountType,
                  overCreditLimit,
                  isBlocked: tradeCustomer.blocked !== 'none',
                },
              },
            },
            tx,
          );
          if (outcome.required && !outcome.released) {
            await OrderStages.moveIn(tx, saved.id, 'approval_requested', 'entered', { source: 'staff', actor: { type: 'user', id: params.requestedBy ?? null }, ref: { type: 'approval_request', id: saved.id } });
            order.approvalStatus = 'pending';
          } else if (floorBreach && !outcome.required) {
            // Below a floor and no approval workflow covers it: that is what the floor is for.
            throw new Error(
              `${floorBreach.text} It needs approval, but no approval workflow covers it. Ask an administrator to set one up for orders below their price floor.`,
            );
          } else if (overCreditLimit) {
            // Over the limit and nothing releases it: that is exactly what the limit is for.
            throw new Error(
              `${tradeCustomer.name} would exceed the credit limit of ${Number(tradeCustomer.creditLimit).toLocaleString()}.`,
            );
          }
        },
        // Who placed it and from where is the first event of the order's timeline; a shop checkout carries the time the shopper started it.
        {
          ...placedBy(channel, params.customerId ?? null, params.requestedBy ?? null),
          startedAt: params.checkoutStartedAt ?? null,
        },
      );
      await customers.postInvoice({
        customer: tradeCustomer,
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: totalAmount,
        currency: order.currency,
      });
    } catch (err) {
      // The order was not created, so the stock set aside for it must not stay reserved.
      await InventoryReservationService.releaseOrder(
        orderId,
        'order creation failed',
        'system',
        stockItems,
      ).catch((releaseError: unknown) =>
        console.error('[orders] could not release reservation', releaseError),
      );
      // A refusal we wrote (credit limit, approval, a floor) is told as it is. A failure of the database is never: its text holds the
      // query and its values. It is logged in full for the people who run the system, and the shopper is told something they can act on.
      const failure = databaseFailure(err);
      if (failure !== null) console.error('[orders] the order could not be saved', failure);
      const message = refusalMessage(err, failure);
      return {
        success: false,
        error: message,
        code: refusalCodeOf(message),
      };
    }

    // The stock was set aside before the order existed; now the order's own timeline says so, and where.
    if (stockItems.length > 0) await InventoryReservationService.recordReserved(orderId, stockItems);

    void broadcastRealtime('order_event', { type: 'order_created', order });

    return { success: true, order };
  },
};
