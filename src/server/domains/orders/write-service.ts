import { quantityProblem } from '@/lib/unit-rules';
import { randomUUID } from 'node:crypto';
import type { Order, OrderItem, PaymentProvider } from '@/types/index';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { getContainer } from '@/server/di/container';
import { CatalogService } from '@/server/domains/catalog/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { broadcastRealtime } from '@/server/realtime';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { eq, inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { orders as ordersTable, products as productsTable } from '@/server/db/drizzle/schema';
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

/** What one line costs: the quote's own figure, else what the price lists gave, else the standard price. */
function lineAmounts(
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

export const OrderWriteService = {
  async createOrder(raw: {
    userId?: string | null;
    branchId?: string | null;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
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
  }): Promise<{ success: boolean; order?: Order; error?: string }> {
    // A shopper may leave the email out; whatever is given is checked here, not trusted from the browser.
    const contact = readOptionalEmail(raw.customerEmail);
    if (!contact.ok) return { success: false, error: contact.error };
    const params = { ...raw, customerEmail: contact.email };
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
      if (problem !== null) return { success: false, error: problem };
    }

    // Staff channels are priced from the price lists. The web shop keeps the standard price, so
    // what a shopper is shown is what they are charged, until the storefront shows list prices.
    const channel =
      params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce');
    const engine = new Map<number, PriceResult>();
    let saleCompanyId = '';
    let saleCustomerId: string | null = null;
    if (channel !== 'ecommerce') {
      const { companySettings, customers, pricing } = getContainer();
      const company = await companySettings.ensureSeeded();
      const known = await customers.lookupByEmail(company.id, params.customerEmail);
      saleCompanyId = company.id;
      saleCustomerId = known?.id ?? null;
      const toPrice: number[] = [];
      params.items.forEach((item, i) => {
        const prod = catalogProducts.get(item.productId);
        if (prod !== undefined && prod.isSellable && !quotedItems.has(item.productId))
          toPrice.push(i);
      });
      const priced = await pricing.priceLines(
        company.id,
        {
          customerId: known?.id ?? null,
          branchId: params.branchId ?? null,
          salesType: channel === 'credit_sale' ? 'credit' : 'cash',
          channel,
        },
        toPrice.map((i) => {
          const item = nth(params.items, i);
          const prod = required(catalogProducts.get(item.productId), 'the product');
          const inclusive = prod.isTaxInclusive !== false;
          return {
            productId: item.productId,
            quantity: item.quantity,
            standardPrice: prod.price ?? null,
            taxRate: prod.taxRate ?? 0,
            lineTaxInclusive: inclusive,
            standardTaxInclusive: inclusive,
          };
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
        return { success: false, error: `Product ID ${item.productId} does not exist.` };
      }
      const quoted = quotedItems.get(item.productId);
      if (!prod.isSellable && !quoted) {
        return { success: false, error: `${prod.name} is not sellable and cannot be ordered.` };
      }
      const priced = engine.get(index);
      if (priced && priced.unitPrice == null) {
        return {
          success: false,
          error: `${prod.name} cannot be priced. ${priced.trace.steps.at(-1) ?? ''}`.trim(),
        };
      }
      if (
        !quoted &&
        !priced &&
        (prod.price == null || !Number.isFinite(prod.price) || prod.price <= 0)
      ) {
        return { success: false, error: `${prod.name} has no valid selling price.` };
      }
      const { unitPrice, total: itemTotal } = lineAmounts(
        quoted,
        priced,
        prod.price,
        item.quantity,
      );
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
        return { success: false, error: `Coupon ${bad.code}: ${bad.reason}` };
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
    if (guarded.length > 0) {
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
      if (verdict.blocked.length > 0) return { success: false, error: nth(verdict.blocked, 0) };
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
    );
    if (kitDefs.size > 0) {
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
        if (error instanceof KitError) return { success: false, error: error.message };
        throw error;
      }
    }
    // Stock is held for what actually ships: components and gifts, not the kit itself.
    const stockItems = orderItems.map((i) => ({ productId: i.productId, quantity: i.quantity }));

    const { subtotal, tax, shippingFee, totalAmount } =
      params.quotedTotals ?? computeCheckoutTotals(pricedLines);
    const orderId =
      // Unguessable: the id is the only key for a guest's invoice download.
      params.orderId ?? `ord_${randomUUID()}`;
    // The order number comes from the number series, assigned inside the transaction that saves
    // the order. A caller may still pass an explicit one (a typed-in number).
    const explicitOrderNumber = params.orderNumber;

    const reservation = await InventoryReservationService.reserveForOrder(
      stockItems,
      orderId,
      params.customerEmail,
    );
    if (!reservation.success) {
      return { success: false, error: reservation.error };
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
      shippingAddress: params.shippingAddress,
      items: orderItems,
      subtotal,
      tax,
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
        params.branchId,
        has(explicitOrderNumber)
          ? undefined
          : async (tx) =>
              (
                await numbering.assign(
                  'sales_order',
                  {
                    companyId: company.id,
                    branchId: params.branchId ?? null,
                    date: businessDate(),
                    document: { kind: 'sales_order', id: order.id },
                  },
                  tx,
                )
              ).number,
        async (tx, saved) => {
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
            { companyId: company.id, customerId: tradeCustomer.id, branchId: params.branchId },
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
              branchId: params.branchId ?? null,
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
            await tx
              .update(ordersTable)
              .set({ approvalStatus: 'pending' })
              .where(eq(ordersTable.id, saved.id));
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
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Customer or dimension assignment failed',
      };
    }

    void broadcastRealtime('order_event', { type: 'order_created', order });

    return { success: true, order };
  },
};
