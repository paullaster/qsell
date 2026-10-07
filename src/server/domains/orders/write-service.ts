import { randomUUID } from 'node:crypto';
import type { Order, OrderItem, PaymentProvider } from '@/types/index';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { getContainer } from '@/server/di/container';
import { CatalogService } from '@/server/domains/catalog/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { broadcastRealtime } from '@/server/realtime';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { eq } from 'drizzle-orm';
import { orders as ordersTable } from '@/server/db/drizzle/schema';
import { needsApprovalCheck } from './approval';
import type { PriceResult, PriceTrace } from '@/server/domains/pricing/domain/types';

export class OrderWriteService {
  static async createOrder(params: {
    userId?: string | null;
    branchId?: string | null;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
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
    /** Flat fields (globalDimension1Code) or { global, shortcut } projection */
    dimensionFields?:
      | Record<string, string | null | undefined>
      | {
          global: Record<string, string>;
          shortcut: Record<string, string>;
        };
  }): Promise<{ success: boolean; order?: Order; error?: string }> {
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

    // Staff channels are priced from the price lists. The web shop keeps the standard price, so
    // what a shopper is shown is what they are charged, until the storefront shows list prices.
    const channel =
      params.paymentMethod === 'on_account' ? 'credit_sale' : (params.salesModule ?? 'ecommerce');
    const engine = new Map<number, PriceResult>();
    if (channel !== 'ecommerce') {
      const { companySettings, customers, pricing } = getContainer();
      const company = await companySettings.ensureSeeded();
      const known = await customers.lookupByEmail(company.id, params.customerEmail);
      const toPrice: number[] = [];
      params.items.forEach((item, i) => {
        const prod = catalogProducts.get(item.productId);
        if (prod && prod.isSellable !== false && !quotedItems.has(item.productId)) toPrice.push(i);
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
          const item = params.items[i]!;
          const prod = catalogProducts.get(item.productId)!;
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
      toPrice.forEach((i, n) => engine.set(i, priced[n]!));
    }

    for (const [index, item] of params.items.entries()) {
      const prod = catalogProducts.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} does not exist.` };
      }
      const quoted = quotedItems.get(item.productId);
      if (prod.isSellable === false && !quoted) {
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
      const unitPrice = quoted
        ? quoted.lineAmount / Math.max(quoted.quantity, 1)
        : priced
          ? priced.lineTotal! / Math.max(item.quantity, 1)
          : prod.price!;
      const itemTotal = quoted
        ? quoted.lineAmount
        : priced
          ? priced.lineTotal!
          : unitPrice * item.quantity;
      orderItems.push({
        productId: prod.id,
        productName: quoted?.productName ?? prod.name,
        sku: quoted?.sku ?? prod.sku,
        quantity: item.quantity,
        unitPrice,
        totalPrice: itemTotal,
        imageUrl: prod.imageUrl,
        priceTrace: quoted ? (quoted.priceTrace ?? null) : (priced?.trace ?? null),
      });
      pricedLines.push({
        productId: prod.id,
        quantity: item.quantity,
        unitPrice,
        taxRate: quoted?.taxRate ?? prod.taxRate ?? 0,
        isTaxInclusive: quoted?.isTaxInclusive ?? prod.isTaxInclusive !== false,
      });
    }

    const { subtotal, tax, shippingFee, totalAmount } =
      params.quotedTotals ?? computeCheckoutTotals(pricedLines);
    const orderId =
      // Unguessable: the id is the only key for a guest's invoice download.
      params.orderId ?? `ord_${randomUUID()}`;
    // The order number comes from the number series, assigned inside the transaction that saves
    // the order. A caller may still pass an explicit one (a typed-in number).
    const explicitOrderNumber = params.orderNumber;

    const reservation = await InventoryReservationService.reserveForOrder(
      params.items,
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
    let resolvedUserId = params.userId || '';

    const order: Order = {
      id: orderId,
      orderNumber: explicitOrderNumber ?? '',
      userId: resolvedUserId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
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
      if (!resolvedUserId) resolvedUserId = tradeCustomer.id;
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
        hasCallerDimensions ? callerDimensions! : tradeCustomer.dimensionCodes,
      );
      order.dimensionSetId = assignment.dimensionSetId;
      order.dimensionCodes = assignment.dimensionCodes;
      order.tradeCustomerId = tradeCustomer.id;
      order.customerAccountType = tradeCustomer.accountType as 'cash' | 'credit';
      order.transmitInvoicesToKra = tradeCustomer.transmitInvoicesToKra;
      // Whether it is signed is decided when its tax invoice is issued, by the signing
      // service, which then owns this status. 'pending' only means "not decided yet".
      order.kraTransmissionStatus = 'pending';

      const { orders: orderRepo, numbering, approvals } = getContainer();
      await orderRepo.create(
        order,
        params.branchId,
        explicitOrderNumber
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
        gated
          ? async (tx, saved) => {
              const outcome = await approvals.submit(
                {
                  companyId: company.id,
                  trigger: 'sales_order.submitted',
                  documentId: saved.id,
                  branchId: params.branchId ?? null,
                  requestedBy: params.requestedBy!,
                  amount: totalAmount,
                  snapshot: {
                    salesModule: order.salesModule,
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
              } else if (overCreditLimit) {
                // Over the limit and nothing releases it: that is exactly what the limit is for.
                throw new Error(
                  `${tradeCustomer.name} would exceed the credit limit of ${Number(tradeCustomer.creditLimit).toLocaleString()}.`,
                );
              }
            }
          : undefined,
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
        params.items,
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
  }
}
